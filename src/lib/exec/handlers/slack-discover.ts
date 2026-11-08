import "server-only";

import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { classifyConversation, toClassRow } from "@/lib/exec/slack-classes";
import {
  boxedWaitMs,
  classifierContext,
  enqueueSlackSweepNow,
  grantedTypes,
  invalidateClassifierContext,
  isAbort,
  isSlackAuthError,
  leaseHolder,
  openReader,
  paced,
  readErrLabel,
  utcHour
} from "@/lib/exec/slack-read";
import { applyClasses, finishDiscovery, listUnclassified } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import type { ChannelClass, ClassRow, DenyReason } from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import { listBotUserIds, listConversations, listMemberConversationIds, type SlackConversation } from "@/lib/exec/sources/slack";
import { releaseLease, tryAcquireLease } from "@/lib/exec/sync-state";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-discover (P7a contract §3.11.1, N2, C8, C26, C34; Area D): the
// metadata pass that classifies every conversation before anything is read.
// Bulk lane, 300 s, three attempts; after the read consent, daily at 05:10,
// and again 15 minutes after a partial run.
//
//   1  The reader (schema, a live reading half) and the discovery lease.
//   2  The DD bot's identity, refreshed (best-effort, C28).
//   3  The bot set (users.list, every page); a failure leaves it unknown, so
//      IMs with an unresolved counterpart stay unclassified (fail closed).
//   4  The classifier context: any DD read failing throws before anything is
//      applied (never classify against a partial deny list, N1).
//   5  conversations.list for the GRANTED types only (C26), every page, and the
//      two users.conversations listings (C34: his Slack mutes are their
//      difference, when they differ). No history call (P7-5), no text. The listings wait into the limiter's next
//      window while the 240 s box lasts (Tier 2 allows 15 pages a minute: a large workspace needs more than one).
//   6  Classify, apply in chunks of 200 (RPC 12).
//   7  A complete run finishes discovery (RPC 13: conversations no longer
//      listed are purged, the reading half becomes ready); a partial one
//      enqueues a retry and stops.
//   8  With reading on: a sweep now, and under active_public a probe.
// Returns counts and codes only.

const KIND = SLACK_READ_JOB_KINDS.discover;
const LEASE_TTL_MS = 360_000;
const PAGE = SLACK_READ_LIMITS.pageLimit;
/** Pages per listing: a ceiling well above any workspace DD knows (200 per page). */
const MAX_PAGES = 100;
const RETRY_DELAY_MS = 15 * 60_000;
const CLASSIFY_BATCH = 50;

export type SlackDiscoverResult =
  | { skipped: string }
  | { conversations: number; byClass: Partial<Record<ChannelClass, number>>; deniedByReason: Partial<Record<DenyReason, number>>;
      removed: number; complete: boolean; partial?: true; upserted: number; purged: number; classifyJobs: number };

function parsePayload(raw: unknown): { installationId?: string } | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.installation_id === undefined) return {};
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  return { installationId: p.installation_id };
}

async function runDiscover(ctx: JobContext): Promise<SlackDiscoverResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parsePayload(ctx.job.payload);
  if (!payload) return { skipped: "bad_payload" };
  const signal = ctx.signal;
  // 1.
  const ri = await openReader(principal, payload.installationId, { signal });
  if (!ri) return { skipped: "not_reading" };
  const holder = leaseHolder(ctx);
  if (!(await tryAcquireLease(principal, "slack-discover-lease", holder, LEASE_TTL_MS))) return { skipped: "lease" };
  try {
    const startedMs = Date.now();
    const runStartedAt = new Date(startedMs).toISOString();
    const inBox = () => Date.now() - startedMs < SLACK_READ_LIMITS.discoverTimeBoxMs;
    // correctness-7: a listing that needs more pages than one minute's budget waits for the next window (within the box).
    const waitMs = () => boxedWaitMs(startedMs, SLACK_READ_LIMITS.discoverTimeBoxMs);

    // 2. C28: refreshed now; a failure is tolerated (the bot set and the briefings channel still deny its DM).
    try {
      await getDdBotIdentity(ri.row.teamId, { refresh: true, signal });
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      console.warn(`[exec-slack] discover ${ri.row.id}: DD bot identity not refreshed (${readErrLabel(err)})`);
    }

    // 3. The bot set; any failure → unknown (null).
    let botUserIds: Set<string> | null = new Set();
    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await paced(ri, "users.list", "discovery", () => listBotUserIds(ri.target, { cursor, limit: PAGE }, { signal }), { signal, maxWaitMs: waitMs() });
        for (const id of r.botUserIds) botUserIds.add(id);
        cursor = r.nextCursor;
        if (cursor === null || cursor === "") break;
        if (page === MAX_PAGES - 1) throw new Error("too many pages");
      }
    } catch (err) {
      if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
      console.warn(`[exec-slack] discover ${ri.row.id}: the bot list is unavailable (${readErrLabel(err)}); bot IMs stay unclassified`);
      botUserIds = null;
    }

    // 4. Every DD read, fresh: a throw ends the run before anything is applied (retryable).
    invalidateClassifierContext(principal.id);
    const base = await classifierContext(principal, ri, { botUserIds, slackMutedIds: null, signal });

    // 5. The listings, for the granted types only.
    const types = grantedTypes(ri.reading.scopes);
    const typeList = [...types];
    let complete = true;
    const byId = new Map<string, SlackConversation>();
    try {
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        if (!inBox() || page >= MAX_PAGES) {
          complete = false;
          break;
        }
        const r = await paced(ri, "conversations.list", "discovery",
          () => listConversations(ri.target, { types: typeList, cursor, limit: PAGE, excludeArchived: true }, { signal }), { signal, maxWaitMs: waitMs() });
        for (const c of r.items) if (types.has(c.convType) && !byId.has(c.id)) byId.set(c.id, c);
        cursor = r.nextCursor;
        if (cursor === null || cursor === "") break;
      }
    } catch (err) {
      if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
      console.warn(`[exec-slack] discover ${ri.row.id}: the conversation list stopped early (${readErrLabel(err)})`);
      complete = false;
    }
    const memberIds = async (excludeMuted: boolean): Promise<Set<string> | null> => {
      const ids = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        if (!inBox() || page >= MAX_PAGES) return null;
        const r = await paced(ri, "users.conversations", "discovery",
          () => listMemberConversationIds(ri.target, { types: typeList, cursor, limit: PAGE, excludeMuted }, { signal }), { signal, maxWaitMs: waitMs() });
        for (const id of r.ids) ids.add(id);
        cursor = r.nextCursor;
        if (cursor === null || cursor === "") return ids;
      }
    };
    let slackMutedIds: Set<string> | null = null;
    if (complete && typeList.length > 0) {
      try {
        const all = await memberIds(false);
        const unmuted = all === null ? null : await memberIds(true);
        if (all === null || unmuted === null) complete = false;
        else {
          const muted = [...all].filter((id) => !unmuted.has(id));
          // C34: equal listings mean exclude_muted doesn't reflect his mutes for a user token; nothing is muted by it.
          slackMutedIds = muted.length > 0 ? new Set(muted) : null;
        }
      } catch (err) {
        if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
        console.warn(`[exec-slack] discover ${ri.row.id}: the membership lists stopped early (${readErrLabel(err)})`);
        complete = false;
      }
    }

    // 6. Classify and apply (chunks of 200, in order).
    const classCtx = { ...base, botUserIds, slackMutedIds };
    const rows: ClassRow[] = [];
    const byClass: Partial<Record<ChannelClass, number>> = {};
    const deniedByReason: Partial<Record<DenyReason, number>> = {};
    for (const conv of byId.values()) {
      const c = classifyConversation(conv, classCtx);
      byClass[c.class] = (byClass[c.class] ?? 0) + 1;
      if (c.class === "deny" && c.denyReason !== null) deniedByReason[c.denyReason] = (deniedByReason[c.denyReason] ?? 0) + 1;
      rows.push(toClassRow(conv, c));
    }
    let upserted = 0;
    let purged = 0;
    for (let i = 0; i < rows.length; i += SLACK_READ_LIMITS.discoverChunk) {
      const r = await applyClasses(principal, ri.row.id, rows.slice(i, i + SLACK_READ_LIMITS.discoverChunk), runStartedAt);
      upserted += r.upserted;
      purged += r.purged;
    }

    // Conversations still unclassified (an unknown IM counterpart, a reset rename) get their own classify job.
    let classifyJobs = 0;
    const now = new Date();
    for (const row of await listUnclassified(principal, CLASSIFY_BATCH)) {
      try {
        const r = await enqueueJob({
          kind: SLACK_READ_JOB_KINDS.classify,
          lane: "bulk",
          principalId: principal.id,
          payload: { installation_id: ri.row.id, channel: row.channelId },
          dedupeKey: `slack-classify:${principal.id}:${row.channelId}:h${utcHour(now)}`,
          maxAttempts: 3
        });
        if (r.enqueued) classifyJobs += 1;
      } catch (err) {
        console.warn(`[exec-slack] discover ${ri.row.id}: classify job for ${row.channelId} not enqueued (${readErrLabel(err)})`);
      }
    }

    // 7.
    const counts = { conversations: rows.length, byClass, deniedByReason, upserted, purged, classifyJobs };
    if (!complete) {
      await enqueueJob({
        kind: KIND,
        lane: "bulk",
        principalId: principal.id,
        payload: { installation_id: ri.row.id, reason: "retry" },
        dedupeKey: `slack-discover:retry:${ri.row.id}:${utcHour(now)}`,
        runAfter: new Date(now.getTime() + RETRY_DELAY_MS),
        maxAttempts: 3
      });
      return { ...counts, removed: 0, complete: false, partial: true };
    }
    const finished = await finishDiscovery(principal, ri.row.id, runStartedAt);

    // 8.
    const settings = await loadSettings(principal.id);
    if (settings.slackReadingSchemaReady && settings.slackReadingEnabled) {
      await enqueueSlackSweepNow(principal, "discover", now);
      if (settings.watchMode === "active_public") {
        await enqueueJob({
          kind: SLACK_READ_JOB_KINDS.probe,
          lane: "bulk",
          principalId: principal.id,
          payload: { reason: "discover" },
          dedupeKey: `slack-probe-now:${principal.id}:${Math.floor(now.getTime() / 60_000)}`,
          maxAttempts: 1
        });
      }
    }
    return { ...counts, removed: finished.removed, complete: true };
  } finally {
    // 9.
    await releaseLease(principal, "slack-discover-lease", holder);
  }
}

export const SLACK_DISCOVER_TIMEOUT_MS = SLACK_READ_LIMITS.discoverTimeoutMs;

export const slackDiscoverJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_DISCOVER_TIMEOUT_MS,
  run: (ctx: JobContext) => runDiscover(ctx)
};

/** Daily at 05:10 local while the P7a schema is installed (the handler skips without a live reading half). */
export const slackDiscoverScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "daily", at: () => "05:10" },
  enabled: (s) => s.slackReadingSchemaReady,
  maxAttempts: 3
};
