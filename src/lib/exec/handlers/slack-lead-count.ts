import "server-only";

import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { leadMapRows, leadNeedsFinal, leadRetentionDays, leadRunDue, leadWindowFor, tallyShapes } from "@/lib/exec/slack-leads";
import {
  SlackLeadsStoreError,
  applyLeadMap,
  dropLeadChannel,
  leadSchemaReady,
  listLeadChannelStates,
  listLeadMarkers,
  noteLeadChannelError,
  putLeadCounts
} from "@/lib/exec/slack-leads-store";
import { SLACK_P10_OPS } from "@/lib/exec/slack-p10-copy";
import {
  P10_JOB_KINDS,
  P10_LIMITS,
  type FbLeadListRow,
  type LeadChannelState,
  type LeadDayCount,
  type LeadExclusions,
  type LeadRunSummary
} from "@/lib/exec/slack-p10-types";
import {
  boxedWaitMs,
  grantedTypes,
  isAbort,
  isRateLimited,
  isSlackAuthError,
  leaseHolder,
  openReader,
  paced,
  slackErrorOf,
  utcHour
} from "@/lib/exec/slack-read";
import { SLACK_READ_JOB_KINDS, msToTs, type ReadingInstallation } from "@/lib/exec/slack-read-types";
import { bucketFromDedupeKey, isInWorkWindow, type WeeklySchedule } from "@/lib/exec/slack-schedule";
import { DdReadError, listFbLeadChannelsV2, listUserSchedules } from "@/lib/exec/sources/dd";
import { listMemberChannels, readHistoryShapes, type LeadPostShape } from "@/lib/exec/sources/slack";
import { getSyncState, parseLeadRunSummary, putSyncState, releaseLease, tryAcquireLease } from "@/lib/exec/sync-state";
import { addLocalDays, endOfLocalDateUtc, localDateString, localTimeToUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings, JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-lead-count (P10 contract §3.4.5, C13-C24; Area B): counts only. Bulk lane, 300 s, maxAttempts 1, lease
// slack-leads-lease; payload {} (scheduled) or { reason: "settings" | "brief" } (forced); the result carries counts and codes
// only (B-P10-6). It never imports a content reader (B-P10-3): the only Slack reads are users.conversations (ids and names,
// in memory for this run only) and readHistoryShapes, which returns a ts and shape flags per post and nothing else (C12).
//
//   1  Gates: both schemas, the switch, reading on, the P10 tables, a live and discovered reading half.
//   2  Due (C16), unless forced: the last run's summary, his work window, the scheduler's bucket.
//   3  The lease, released in finally.
//   4  The typed list (exec_slack_fb_lead_channels_v2): a DD read failure skips the run with nothing written.
//   5  Membership (C18): users.conversations for channels and private channels, every page or the listing is incomplete
//      (an incomplete listing never deletes a lead row).
//   6  The map (C18-C20, C24): the counted set is the lead markers he is a member of; a readable row the typed list names gets
//      P7a's classify job (11 minutes out, one per hour).
//   7  The DD bot's ids, excluded inside the reader (USLACKBOT always).
//   8  Count (C13-C15, C17, v1.1 correctness-2): oldest counted first, ≤ 100 pages a run, ≤ 10 per channel window, the
//      8-day final pass once a local day (retried at most every 6 hours) with the per-day fallback when it caps; a day not read
//      in full is never written as a full count, and an unread day is never written at all.
//   9  Errors (C22): not_in_channel / channel_not_found drop the channel's rows and re-classify it; a rate limit or a used-up
//      budget ends the run partial; an auth-class error ends it (rethrown, paced recorded it); any other code is stored on the
//      channel's row (never logged with the channel id, C21) and the next channel is counted.
//  10  The summary (exec_sync_state slack / lead-run): counts, codes, DD task ids and positions; three failing runs in a row
//      raise one rate-limited ops alert (C55) with a code-only detail.

const LEASE = "slack-leads-lease" as const;
const DAY_MS = 86_400_000;
const CLASSIFY_DELAY_MS = P10_LIMITS.leadClassifyDelayMs;
const MEMBER_PAGE_LIMIT = 200;
const ERROR_CODE_RE = /^[a-z0-9_]{1,60}$/;

export type SlackLeadCountResult =
  | { skipped: "no_principal" | "bad_payload" | "off" | "reading_off" | "not_installed" | "not_reading" | "off_window" | "lease" | "dd_read" }
  | { channels: number; counted: number; pages: number; partial: boolean; needsFinal: number; errors: Record<string, number> };

function parsePayload(raw: unknown): { reason: "settings" | "brief" | null } | null {
  if (raw === undefined || raw === null) return { reason: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = (raw as Record<string, unknown>).reason;
  if (r === undefined) return { reason: null };
  return r === "settings" || r === "brief" ? { reason: r } : null;
}

/** A per-channel error's code for its row and the summary: the Slack code when it is one, else "error" (never a message). */
function leadErrorCode(err: unknown): string {
  const code = slackErrorOf(err)?.code ?? null;
  return code !== null && ERROR_CODE_RE.test(code) ? code : "error";
}

/** The code a failed run ends on (v1.1 product-2): an auth error's Slack code (else "auth"), "store" for a store error. */
function failCodeOf(err: unknown): string {
  if (isSlackAuthError(err)) {
    const code = slackErrorOf(err)?.code ?? null;
    return code !== null && ERROR_CODE_RE.test(code) ? code : "auth";
  }
  return "store";
}

const bump = (errors: Record<string, number>, code: string): void => {
  errors[code] = (errors[code] ?? 0) + 1;
};

/** P7a's classify job for one channel (C24, C22): bulk, 3 attempts, 11 minutes out (past the classifier context's cache), one
 *  per channel per UTC hour. Never throws: a failure is logged by principal id and code. */
async function enqueueClassify(principal: ExecPrincipal, installationId: string, channel: string, now: Date): Promise<boolean> {
  try {
    const r = await enqueueJob({
      kind: SLACK_READ_JOB_KINDS.classify,
      lane: "bulk",
      principalId: principal.id,
      payload: { installation_id: installationId, channel },
      dedupeKey: `slack-classify:${principal.id}:${channel}:l${utcHour(now)}`,
      runAfter: new Date(now.getTime() + CLASSIFY_DELAY_MS),
      maxAttempts: 3
    });
    return r.enqueued;
  } catch (err) {
    console.warn(`[exec-slack-leads] lead run ${principal.id}: a classify job was not enqueued (${leadErrorCode(err)})`);
    return false;
  }
}

interface RunState {
  pages: number;
  counted: number;
  partial: boolean;
  membershipComplete: boolean;
  classifyEnqueued: number;
  channels: number;
  listedNotMember: number;
  notMember: { taskId: string; i: number }[];
  errors: Record<string, number>;
  needsFinal: number;
}

/** His work schedule from DD (a failure reads as none: P7a's default window, as the sweep does). */
async function scheduleOf(principal: ExecPrincipal, signal: AbortSignal): Promise<WeeklySchedule> {
  try {
    const mine = (await listUserSchedules(principal, { signal })).find((s) => s.userId === principal.userId);
    return (mine?.weeklySchedule ?? {}) as WeeklySchedule;
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    return {};
  }
}

async function runLeadCount(ctx: JobContext): Promise<SlackLeadCountResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parsePayload(ctx.job.payload);
  if (!payload) return { skipped: "bad_payload" };
  const signal = ctx.signal;

  // 1. Gates.
  const settings = await loadSettings(principal.id);
  if (!settings.slackP10SchemaReady || !settings.slackReadingSchemaReady) return { skipped: "not_installed" };
  if (!settings.slackLeadCountsEnabled) return { skipped: "off" };
  if (!settings.slackReadingEnabled) return { skipped: "reading_off" };
  if (!(await leadSchemaReady({ signal }))) return { skipped: "not_installed" };
  const ri = await openReader(principal, undefined, { signal });
  if (!ri || ri.reading.discoveredAt === null) return { skipped: "not_reading" };

  // 2. Due (C16).
  const now = new Date();
  const forced = payload.reason !== null;
  const last = (await getSyncState(principal, "slack", "lead-run", parseLeadRunSummary, { signal }))?.value ?? null;
  if (!forced) {
    const schedule = await scheduleOf(principal, signal);
    const due = leadRunDue({ forced, bucket: bucketFromDedupeKey(ctx.job.dedupe_key), inWindow: isInWorkWindow(now, principal.timezone, schedule), last });
    if (!due) return { skipped: "off_window" };
  }

  // 3. The lease.
  const holder = leaseHolder(ctx);
  if (!(await tryAcquireLease(principal, LEASE, holder, P10_LIMITS.leadLeaseMs))) return { skipped: "lease" };
  try {
    return await countAll(principal, ri, settings, now, signal, last, payload.reason === "brief");
  } finally {
    await releaseLease(principal, LEASE, holder);
  }
}

/** Three failing runs in a row raise one rate-limited ops alert (C55), with a code-only detail (never a channel id). */
async function alertIfFailing(principal: ExecPrincipal, failingRuns: number, failCode: string): Promise<void> {
  if (failingRuns < P10_LIMITS.leadFailingRuns) return;
  await notifyOps({
    key: SLACK_P10_OPS.leadRunFailing.key(principal.id),
    title: SLACK_P10_OPS.leadRunFailing.title,
    detail: `${failingRuns} lead-count runs in a row ended on ${failCode}.`
  });
}

/** `briefRun` (P10 fixer correctness-2): the brief's own forced run takes the final window for every channel whose final pass
 *  hasn't covered yesterday, past the 6-hour retry gate, so the brief never reads a pre-midnight snapshot as yesterday. */
async function countAll(principal: ExecPrincipal, ri: ReadingInstallation, settings: ExecSettings, now: Date, signal: AbortSignal,
  last: LeadRunSummary | null, briefRun = false): Promise<SlackLeadCountResult> {
  const startedMs = Date.now();
  const nowMs = now.getTime();
  const inBox = () => Date.now() - startedMs < P10_LIMITS.leadRunBoxMs;
  const waitMs = () => boxedWaitMs(startedMs, P10_LIMITS.leadRunBoxMs);
  const st: RunState = {
    pages: 0, counted: 0, partial: false, membershipComplete: true, classifyEnqueued: 0, channels: 0, listedNotMember: 0, notMember: [],
    errors: {}, needsFinal: 0
  };

  // 4. The typed list: a DD read failure changes no count. P10 fixer ui-5: it is a failing run all the same (failCode dd_read,
  //    failingRuns + 1, the last run's coverage numbers carried), so the System card and the brief say the counts aren't
  //    ready instead of showing the last good run, and a first run that never gets the list isn't "the first time" forever.
  let list: FbLeadListRow[];
  try {
    list = await listFbLeadChannelsV2(principal, { signal });
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    if (err instanceof DdReadError) {
      console.warn(`[exec-slack-leads] lead run ${principal.id}: skipped (dd_read)`);
      const failingRuns = Math.min(1_000, (last?.failingRuns ?? 0) + 1);
      st.channels = last?.channels ?? 0;
      st.listedNotMember = last?.listedNotMember ?? 0;
      st.notMember = Array.isArray(last?.notMember) ? last.notMember : [];
      st.needsFinal = last?.needsFinal ?? 0;
      try {
        await putSyncState(principal, "slack", "lead-run", summaryOf(st, now, true, failingRuns, "dd_read"));
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        console.warn(`[exec-slack-leads] lead run ${principal.id}: the run summary was not saved (${leadErrorCode(e)})`);
      }
      await alertIfFailing(principal, failingRuns, "dd_read");
      return { skipped: "dd_read" };
    }
    throw err;
  }

  try {
    // 5. Membership: channels and private channels he is in (C18). Names stay in this run's memory.
    const types = [...grantedTypes(ri.reading.scopes)].filter((t): t is "channel" | "group" => t === "channel" || t === "group");
    const members = new Map<string, string | null>();
    if (types.length > 0) {
      let cursor: string | null = null;
      try {
        for (let page = 0; ; page += 1) {
          if (page >= P10_LIMITS.leadMemberPages || !inBox()) {
            st.membershipComplete = false;
            break;
          }
          const at: string | null = cursor;
          const r: { channels: { id: string; name: string | null }[]; nextCursor: string | null } = await paced(ri, "users.conversations", "discovery",
            () => listMemberChannels(ri.target, { types, cursor: at, limit: MEMBER_PAGE_LIMIT }, { signal }), { signal, maxWaitMs: waitMs() });
          for (const c of r.channels) if (!members.has(c.id)) members.set(c.id, c.name);
          cursor = r.nextCursor;
          if (cursor === null || cursor === "") break;
        }
      } catch (err) {
        if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
        st.membershipComplete = false;
        if (isRateLimited(err)) st.partial = true;
        bump(st.errors, leadErrorCode(err));
      }
    }

    // 6. Markers and the map (C18-C20, C24).
    const listedIds = [...new Set(list.map((r) => r.channelId).filter((c): c is string => c !== null))];
    const listedSlugs = [...new Set(list.map((r) => r.name).filter((n): n is string => n !== null))];
    const markers = await listLeadMarkers(principal, ri.row.id, listedIds, listedSlugs, { signal });
    const map = leadMapRows({ members, markers, list });
    members.clear();   // the Slack names are needed for nothing else
    // P10 fixer ui-5: a partial membership listing can't say which typed entries he isn't in (every entry it didn't see would
    // read "not a member"): the last run's numbers are carried instead (none on a first run).
    st.listedNotMember = st.membershipComplete ? map.listedNotMember : (last?.listedNotMember ?? 0);
    st.notMember = st.membershipComplete ? map.notMember : (Array.isArray(last?.notMember) ? last.notMember : []);
    for (const channel of map.toClassify) {
      if (await enqueueClassify(principal, ri.row.id, channel, now)) st.classifyEnqueued += 1;
    }
    const retentionDays = leadRetentionDays(settings);
    await applyLeadMap(principal, ri.row.id, map.rows, st.membershipComplete, now, new Date(nowMs + retentionDays * DAY_MS));

    // 7. The DD bot's ids (best effort; USLACKBOT is always excluded inside the reader).
    const exclusions: LeadExclusions = { userIds: [], botIds: [], appIds: [] };
    try {
      const dd = await getDdBotIdentity(ri.row.teamId, { signal });
      if (dd) {
        if (typeof dd.userId === "string" && dd.userId.length > 0) (exclusions.userIds as string[]).push(dd.userId);
        if (typeof dd.botId === "string" && dd.botId.length > 0) (exclusions.botIds as string[]).push(dd.botId);
        if (typeof dd.appId === "string" && dd.appId.length > 0) (exclusions.appIds as string[]).push(dd.appId);
      }
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      console.warn(`[exec-slack-leads] lead run ${principal.id}: DD bot identity unavailable (${leadErrorCode(err)})`);
    }

    // 8. Count, oldest counted first; only the lead channels this run mapped (never a marker he isn't in).
    const tz = principal.timezone;
    const today = localDateString(now, tz);
    const yesterday = addLocalDays(today, -1);
    const mapped = new Set(map.rows.filter((r) => r.kind !== "other").map((r) => r.channelId));
    const states = (await listLeadChannelStates(principal, { signal })).filter((s) => s.kind !== "other" && mapped.has(s.channelId));
    st.channels = states.length;
    const after = new Map<string, Pick<LeadChannelState, "finalThrough" | "finalAttemptAt">>(
      states.map((s) => [s.channelId, { finalThrough: s.finalThrough, finalAttemptAt: s.finalAttemptAt }]));
    const dropped = new Set<string>();
    const budgetLeft = () => st.pages < P10_LIMITS.leadPagesPerRun && inBox();

    /** One page through the limiter (P7a's sweep class); a bad_response (the 1 MiB cap) retries once at limit 25. */
    const readPage = async (channel: string, oldest: string, latest: string | null, cursor: string | null) => {
      const call = (limit: number) => paced(ri, "conversations.history", "sweep",
        () => readHistoryShapes(ri.target, { channel, oldest, latest, inclusive: true, limit, cursor }, exclusions, { signal }), { signal, maxWaitMs: waitMs() });
      st.pages += 1;
      try {
        return await call(P10_LIMITS.leadPageLimit);
      } catch (err) {
        if (slackErrorOf(err)?.code !== "bad_response") throw err;
        st.pages += 1;
        return await call(P10_LIMITS.leadPageLimitRetry);
      }
    };
    /** Newest first, ≤ maxPages; capped = more posts exist than were read (the page cap or the run's budget). */
    const readWindow = async (channel: string, oldest: string, latest: string | null, maxPages: number):
      Promise<{ shapes: LeadPostShape[]; capped: boolean; outOfBudget: boolean }> => {
      const shapes: LeadPostShape[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page += 1) {
        if (!budgetLeft()) return { shapes, capped: true, outOfBudget: true };
        const r = await readPage(channel, oldest, latest, cursor);
        for (const s of r.shapes) shapes.push(s);
        if (!r.hasMore) return { shapes, capped: false, outOfBudget: false };
        if (r.nextCursor === null || r.nextCursor === "") return { shapes, capped: true, outOfBudget: false };
        cursor = r.nextCursor;
      }
      return { shapes, capped: true, outOfBudget: false };
    };
    const dayStartTs = (day: string) => msToTs(localTimeToUtc(day, "00:00", tz).getTime());

    for (const state of states) {
      if (!budgetLeft()) {
        st.partial = true;
        break;
      }
      const w = leadWindowFor(state, today, nowMs, { force: briefRun });
      try {
        const first = await readWindow(state.channelId, dayStartTs(w.from), null, P10_LIMITS.leadPagesPerChannel);
        // The run's own budget running out is no final attempt (it would hold the final pass back 6 hours): only a read that
        // capped on its own page limits, or failed, stamps final_attempt_at.
        let outOfBudget = first.outOfBudget;
        if (first.outOfBudget) st.partial = true;
        const firstTally = tallyShapes(first.shapes, tz, w, first.capped);
        const byDay = new Map<string, LeadDayCount>(firstTally.days.map((d) => [d.day, d]));
        let attemptedAll = firstTally.partialFrom === null;
        // v1.1 correctness-2: a capped final pass reads each remaining day on its own, newest first.
        if (w.final && firstTally.partialFrom !== null) {
          attemptedAll = true;
          for (let d = firstTally.partialFrom; d >= w.from; d = addLocalDays(d, -1)) {
            if (!budgetLeft()) {
              attemptedAll = false;
              outOfBudget = true;
              st.partial = true;
              break;
            }
            const r = await readWindow(state.channelId, dayStartTs(d), dayStartTs(addLocalDays(d, 1)), P10_LIMITS.leadPagesPerDay);
            if (r.outOfBudget) {
              attemptedAll = false;
              outOfBudget = true;
              st.partial = true;
            }
            const t = tallyShapes(r.shapes, tz, { from: d, to: d }, r.capped).days[0];
            if (!t) continue;   // nothing usable read: the day is left out (any earlier lower bound stays)
            // A full count always wins; two lower bounds keep the larger (the read that got further into the day).
            const had = byDay.get(d);
            if (t.complete || had === undefined || (!had.complete && t.n >= had.n)) byDay.set(d, t);
            if (r.outOfBudget) break;
          }
        }
        const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
        const yesterdayDone = days.some((d) => d.day === yesterday && d.complete);
        const finalThrough = w.final && attemptedAll && yesterdayDone ? yesterday : null;
        const finalAttempt = w.final && !outOfBudget;
        const outcome = await putLeadCounts(principal, state.channelId, {
          tz,
          today,
          days: days.map((d) => ({
            day: d.day, n: d.n, skipped: d.skipped, complete: d.complete,
            expiresAt: new Date(endOfLocalDateUtc(d.day, tz).getTime() + retentionDays * DAY_MS).toISOString()
          })),
          countedAt: now,
          finalThrough,
          finalAttempt
        });
        if (outcome === "written") {
          st.counted += 1;
          const prev = after.get(state.channelId) ?? { finalThrough: state.finalThrough, finalAttemptAt: state.finalAttemptAt };
          after.set(state.channelId, {
            finalThrough: finalThrough ?? prev.finalThrough,
            finalAttemptAt: finalAttempt ? now.toISOString() : prev.finalAttemptAt
          });
        }
      } catch (err) {
        if (isAbort(err, signal) || isSlackAuthError(err) || err instanceof SlackLeadsStoreError) throw err;
        if (isRateLimited(err)) {
          st.partial = true;
          bump(st.errors, "ratelimited");
          break;
        }
        const code = leadErrorCode(err);
        bump(st.errors, code);
        if (code === "not_in_channel" || code === "channel_not_found") {
          await dropLeadChannel(principal, state.channelId);
          dropped.add(state.channelId);
          if (await enqueueClassify(principal, ri.row.id, state.channelId, now)) st.classifyEnqueued += 1;
          continue;
        }
        await noteLeadChannelError(principal, state.channelId, code, w.final);
        if (w.final) {
          const prev = after.get(state.channelId) ?? { finalThrough: state.finalThrough, finalAttemptAt: state.finalAttemptAt };
          after.set(state.channelId, { ...prev, finalAttemptAt: now.toISOString() });
        }
      }
    }

    // 10. The summary.
    st.needsFinal = states.filter((s) => !dropped.has(s.channelId) && leadNeedsFinal(after.get(s.channelId) ?? s, today, nowMs)).length;
    st.channels = states.length - dropped.size;
    const partial = st.partial || !st.membershipComplete;
    await putSyncState(principal, "slack", "lead-run", summaryOf(st, now, partial, 0, null));
    return { channels: st.channels, counted: st.counted, pages: st.pages, partial, needsFinal: st.needsFinal, errors: { ...st.errors } };
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    if (isSlackAuthError(err) || err instanceof SlackLeadsStoreError) {
      // The run ended on an auth or store error: record it (counts and a code), raise the alert on the third in a row.
      const failCode = failCodeOf(err);
      const failingRuns = Math.min(1_000, (last?.failingRuns ?? 0) + 1);
      try {
        await putSyncState(principal, "slack", "lead-run", summaryOf(st, now, true, failingRuns, failCode));
      } catch (e) {
        console.warn(`[exec-slack-leads] lead run ${principal.id}: the run summary was not saved (${leadErrorCode(e)})`);
      }
      console.warn(`[exec-slack-leads] lead run ${principal.id}: failed (${failCode})`);
      await alertIfFailing(principal, failingRuns, failCode);
    }
    throw err;
  }
}

function summaryOf(st: RunState, now: Date, partial: boolean, failingRuns: number, failCode: string | null): LeadRunSummary {
  return {
    at: now.toISOString(),
    complete: !partial && st.membershipComplete,
    partial,
    needsFinal: st.needsFinal,
    channels: st.channels,
    counted: st.counted,
    pages: st.pages,
    listedNotMember: st.listedNotMember,
    classifyEnqueued: st.classifyEnqueued,
    errors: { ...st.errors },
    failingRuns,
    failCode,
    notMember: st.notMember.slice(0, P10_LIMITS.leadNotMemberMax)
  };
}

export const slackLeadCountJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.leadCount,
  lane: "bulk",
  timeoutMs: P10_LIMITS.leadRunTimeoutMs,
  run: (ctx) => runLeadCount(ctx)
});

/** §3.4.5 / §3.10: every 30 minutes (interval cadence) while lead counts and reading are on and both schemas are ready; the
 *  due rule (C16) runs inside the job; maxAttempts 1 (the next bucket retries). */
export const slackLeadCountScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: P10_JOB_KINDS.leadCount,
  lane: "bulk",
  cadence: { kind: "interval", minutes: 30 },
  enabled: (s) => s.slackP10SchemaReady && s.slackLeadCountsEnabled && s.slackReadingSchemaReady && s.slackReadingEnabled,
  maxAttempts: 1
});
