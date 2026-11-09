import "server-only";

import { briefHref, checkinsMessageParts, resolveStaleRows } from "@/lib/exec/brief-deliver";
import { purgeLogScrubQuery } from "@/lib/exec/brief-screen";
import { renderScrubbedNote } from "@/lib/exec/brief-slack-ui";
import {
  briefSchemaReady,
  expireCheckins,
  getBriefById,
  listFollowups,
  markDmFollowed,
  oldestBuildInFlight,
  resolveStaleSendingCheckins,
  scrubBriefsForSlack
} from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { dmUpdate, errLabel, slackCodeOf } from "@/lib/exec/slack-dm";
import { listPurgeLog } from "@/lib/exec/slack-reading";
import { openActiveInstallation } from "@/lib/exec/slack-install";
import type { OpenInstallation } from "@/lib/exec/slack-types";
import { getSyncState, parseSlackScrubCursor, putSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal, JobContext, JobHandler } from "@/lib/exec/types";

// exec.brief-sweep (P8 contract §3.13.5, C15, C16, C36, C48, C50; intel-11, intel-13; Area D): every 5 minutes per
// principal: the Slack scrub feed from P7a's purge log, the scrubbed-DM follow-ups, the stale rows (never posts), and the
// check-in expiries. Bulk lane, maxAttempts 1, 60 s. Counts and step names only in its result. Each step fails alone.
//
// The scrub cursor (p8-bindings.md AM-P8-9; FINAL-CODE fact (e), P7b's correctness-1): a purge-log id is allocated at
// insert, not at commit, so a lower id can commit after a higher one was read. The stored afterId therefore never passes a
// row younger than purgeLogSettleMs (15 min: every P7a purge is one short transaction, so a row inserted that long ago is
// committed, and so is every lower id), nor one created at or after the start of a build still in flight (minus
// scrubHoldBackMs, intel-13: its content didn't exist yet). Every row read above the stored afterId is scrubbed on every pass
// until it may be passed: brief scrubs are keyed and idempotent, so re-scrubbing replaces P7b's "done" list.

export const BRIEF_SWEEP_JOB_KIND = BRIEF_JOB_KINDS.sweep;

const STEPS = ["slackScrub", "followups", "staleRows", "checkins"] as const;
type SweepStep = (typeof STEPS)[number];

export interface BriefSweepResult {
  skipped?: string;
  purgeLogRows: number; scrubbedBriefs: number; cursorAdvanced: number;
  followupsUpdated: number; followupsPending: number;
  staleBuild: number; neverBuilt: number; staleDelivering: number; staleBuilt: number;
  checkinsExpired: number; checkinsUnknown: number; checkinMessagesRendered: number;
  failedSteps: SweepStep[];
}

const emptyResult = (): BriefSweepResult => ({
  purgeLogRows: 0, scrubbedBriefs: 0, cursorAdvanced: 0, followupsUpdated: 0, followupsPending: 0, staleBuild: 0, neverBuilt: 0,
  staleDelivering: 0, staleBuilt: 0, checkinsExpired: 0, checkinsUnknown: 0, checkinMessagesRendered: 0, failedSteps: []
});

const ownSignal = (): AbortSignal => AbortSignal.timeout(BRIEF_LIMITS.slackCallMs);
/** chat.update answers that mean the DM is gone or can't be edited any more: the follow-up is done either way. */
const FOLLOWUP_DONE_CODES: ReadonlySet<string> = new Set(["message_not_found", "cant_update_message", "edit_window_closed"]);

/** Step 2 (C16, AM-P8-9). Returns the rows read, the briefs rewritten and how far the stored cursor moved. */
export async function sweepSlackScrubs(principal: ExecPrincipal, now: Date, signal: AbortSignal):
  Promise<{ rows: number; scrubbed: number; advanced: number }> {
  const stored = await getSyncState(principal, "brief", "slack-scrub", parseSlackScrubCursor, { signal });
  const afterId = stored?.value.afterId ?? 0;
  const hold = await oldestBuildInFlight(principal);
  const holdMs = hold !== null && Number.isFinite(Date.parse(hold)) ? Date.parse(hold) - BRIEF_LIMITS.scrubHoldBackMs : Number.POSITIVE_INFINITY;
  // A row may be passed only when it was created before both limits.
  const limitMs = Math.min(now.getTime() - BRIEF_LIMITS.purgeLogSettleMs, holdMs);
  let readFrom = afterId;
  let passable = afterId;
  let blocked = false;
  let rowsRead = 0;
  let scrubbed = 0;
  try {
    for (let batch = 0; batch < BRIEF_LIMITS.purgeLogBatchesPerRun; batch++) {
      signal.throwIfAborted();
      const rows = [...(await listPurgeLog(principal, readFrom, BRIEF_LIMITS.purgeLogBatch))].sort((a, b) => a.id - b.id);
      if (rows.length === 0) break;
      rowsRead += rows.length;
      const q = purgeLogScrubQuery(rows, principal.briefTimezone);
      // The cursor moves only past rows whose scrub succeeded (a throw ends the loop before the advance below).
      const n = await scrubBriefsForSlack(principal, q, { signal });
      scrubbed += n ?? 0;
      for (const row of rows) {
        if (blocked) break;
        const created = Date.parse(row.createdAt);
        if (Number.isFinite(created) && created < limitMs && row.id > passable) passable = row.id;
        else blocked = true;
      }
      readFrom = rows[rows.length - 1].id;
      if (rows.length < BRIEF_LIMITS.purgeLogBatch) break;
    }
  } finally {
    if (passable > afterId) await putSyncState(principal, "brief", "slack-scrub", { afterId: passable }, { signal });
  }
  return { rows: rowsRead, scrubbed, advanced: passable - afterId };
}

/** Step 3 (C15): a delivered DM whose content was scrubbed since is replaced by the fixed note, once per scrub. */
async function sweepFollowups(principal: ExecPrincipal, inst: OpenInstallation | null): Promise<{ updated: number; pending: number }> {
  const due = await listFollowups(principal, 10);
  if (due.length === 0) return { updated: 0, pending: 0 };
  // No installation (or another one's DM): the DM can't be reached; the rows wait (the page says so).
  if (inst === null) return { updated: 0, pending: due.length };
  let updated = 0;
  let pending = 0;
  const parts = renderScrubbedNote(briefHref());
  for (const f of due) {
    if (f.channel !== inst.row.dmChannelId) {
      pending += 1;
      continue;
    }
    try {
      await dmUpdate(inst, f.ts, parts, { signal: ownSignal() });
      await markDmFollowed(f.id, f.scrubbedAt);
      updated += 1;
    } catch (err) {
      const code = slackCodeOf(err);
      if (code !== null && FOLLOWUP_DONE_CODES.has(code)) {
        await markDmFollowed(f.id, f.scrubbedAt);
        updated += 1;
        continue;
      }
      pending += 1;
      console.warn(`[exec-brief] scrubbed DM not replaced (brief ${f.id}): ${errLabel(err)}`);
    }
  }
  return { updated, pending };
}

/** Step 5 (C45, C50): expired proposals; a send that crashed mid-flight becomes unknown (never re-posted) and its message is
 *  re-rendered so it doesn't show "Sending…" forever. */
async function sweepCheckins(principal: ExecPrincipal, inst: OpenInstallation | null, now: Date):
  Promise<{ expired: number; unknown: number; rendered: number }> {
  const expired = await expireCheckins(principal, { expiredBefore: now, reason: "expired" });
  const briefIds = await resolveStaleSendingCheckins(principal, new Date(now.getTime() - BRIEF_LIMITS.checkinSendingStaleMs));
  let rendered = 0;
  for (const id of briefIds) {
    if (inst === null) break;
    try {
      const brief = await getBriefById(principal, id);
      if (brief === null || brief.checkinsTs === null) continue;
      const parts = await checkinsMessageParts(principal, id, { tz: brief.tz, now, paused: null });
      if (parts === null) continue;
      await dmUpdate(inst, brief.checkinsTs, parts, { signal: ownSignal() });
      rendered += 1;
    } catch (err) {
      console.warn(`[exec-brief] check-ins message not re-rendered (brief ${id}): ${errLabel(err)}`);
    }
  }
  return { expired, unknown: briefIds.length, rendered };
}

async function runSweep(ctx: JobContext): Promise<BriefSweepResult> {
  const out = emptyResult();
  const principal = ctx.principal;
  if (!principal) return { ...out, skipped: "no_principal" };
  const signal = ctx.signal;
  // 1.
  if (!(await briefSchemaReady({ signal }))) return { ...out, skipped: "not_installed" };
  const now = new Date();
  const step = async (which: SweepStep, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      if (signal.aborted) throw err;
      out.failedSteps.push(which);
      console.warn(`[exec-brief] sweep step ${which} failed (principal ${principal.id}): ${errLabel(err)}`);
    }
  };
  // 2.
  await step("slackScrub", async () => {
    const r = await sweepSlackScrubs(principal, now, signal);
    out.purgeLogRows = r.rows;
    out.scrubbedBriefs = r.scrubbed;
    out.cursorAdvanced = r.advanced;
  });
  let inst: OpenInstallation | null = null;
  let instRead = false;
  const installation = async (): Promise<OpenInstallation | null> => {
    if (!instRead) {
      instRead = true;
      inst = await openActiveInstallation(principal, { signal });
    }
    return inst;
  };
  // 3.
  await step("followups", async () => {
    const r = await sweepFollowups(principal, await installation());
    out.followupsUpdated = r.updated;
    out.followupsPending = r.pending;
  });
  // 4.
  await step("staleRows", async () => {
    const r = await resolveStaleRows(principal, now, signal);
    out.staleBuild = r.staleBuild;
    out.neverBuilt = r.neverBuilt;
    out.staleDelivering = r.staleDelivering;
    out.staleBuilt = r.staleBuilt;
  });
  // 5.
  await step("checkins", async () => {
    let open: OpenInstallation | null = null;
    try {
      open = await installation();
    } catch {
      open = null;
    }
    const r = await sweepCheckins(principal, open, now);
    out.checkinsExpired = r.expired;
    out.checkinsUnknown = r.unknown;
    out.checkinMessagesRendered = r.rendered;
  });
  // 6.
  return out;
}

export const briefSweepJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: BRIEF_SWEEP_JOB_KIND,
  lane: "bulk",
  timeoutMs: BRIEF_LIMITS.sweepTimeoutMs,
  run: (ctx) => runSweep(ctx)
});

/** §3.6: per principal, every 5 minutes, bulk, maxAttempts 1, payload {}. Ungated (it only removes and resolves). */
export const briefSweepScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: BRIEF_SWEEP_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: BRIEF_LIMITS.sweepMinutes },
  maxAttempts: 1
});
