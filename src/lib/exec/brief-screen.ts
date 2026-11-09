import "server-only";

import { contentRefs, INTAKE_APPROVALS, intakeApprovalFp } from "@/lib/exec/brief-sections";
import { getBriefById, scrubBriefsForSlack, scrubBriefsForThreads } from "@/lib/exec/brief-store";
import { BRIEF_LIMITS, slackDigestBriefKey, slackMessageBriefKey } from "@/lib/exec/brief-types";
import type { BriefContent, BriefRow } from "@/lib/exec/brief-types";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { localDateOfTs } from "@/lib/exec/slack-intel-types";
import * as slackReading from "@/lib/exec/slack-reading";
import { loadScreeningPolicy, screenStoredRow } from "@/lib/exec/sources/mail";
import { getSyncState, parseSlackScrubCursor } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings, SourceRef } from "@/lib/exec/types";

// P8 brief screen (contract §3.17.7, C16, C31; intel-13, intel-14; Area C; server-only): the one render-time screen of
// stored content (the page, the Overview card, the dry run and the DM) and the post-write scrub catch-up (the build after
// finishBuild, the deliver job before its CAS). The screen never writes; the catch-up only calls the store's scrubs, which
// are idempotent and keyed (a row scrubbed twice is the same row).
//
// The Slack cursor (brief / slack-scrub, AM-P8-9) is the sweep's: the catch-up reads the purge log from it and never moves
// it, so a row the sweep still holds back (unsettled, or created while a build was in flight) is applied here too, and
// again by the sweep later. P7a's facade is reached through a guarded accessor: a build where it (or its listPurgeLog)
// isn't there skips the Slack step and still runs the email one. Nothing here logs content: ids and codes only.

export interface BriefScreen {
  /** BriefItem id → why it is withheld now. */
  items: ReadonlyMap<string, "restricted" | "slack">;
  /** Withheld pending lines (by fp) and top-3 entries (by alias). */
  pending: ReadonlySet<string>; top3: ReadonlySet<string>;
  /** P3 thread ids the screen withholds now (catchUpBriefScrubs scrubs them into the row). */
  withheldThreadIds: readonly string[];
  /** Anything withheld → the AI headline isn't shown (it cites no refs; intel-14). */
  hideHeadline: boolean;
}

export const NO_SCREEN: BriefScreen = Object.freeze({
  items: new Map<string, "restricted" | "slack">(),
  pending: new Set<string>(),
  top3: new Set<string>(),
  withheldThreadIds: Object.freeze([] as string[]),
  hideHeadline: false
});

type PurgeRow = { scope: "message" | "conversation" | "reading"; channelId: string | null; ts: string | null };
const CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;

/** Pure. P7a purge-log rows → one scrub query (C16): message rows (any reason) → m:<ch>:<ts> and d:<ch>:<localDateOfTs(ts, tz)>;
 *  conversation rows → channels; any reading row → all. A message row whose ts can't be dated scrubs its whole channel (fail
 *  closed: its digest's date is unknown). */
export function purgeLogScrubQuery(rows: readonly PurgeRow[], tz: string): { slackKeys: string[]; channels: string[]; all: boolean } {
  const keys = new Set<string>();
  const channels = new Set<string>();
  let all = false;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    if (r.scope === "reading") {
      all = true;
      continue;
    }
    if (typeof r.channelId !== "string" || !CHANNEL.test(r.channelId)) continue;
    if (r.scope === "conversation") {
      channels.add(r.channelId);
      continue;
    }
    if (r.scope !== "message" || typeof r.ts !== "string" || r.ts.length === 0) continue;
    keys.add(slackMessageBriefKey(r.channelId, r.ts));
    try {
      keys.add(slackDigestBriefKey(r.channelId, localDateOfTs(r.ts, tz)));
    } catch {
      channels.add(r.channelId);
    }
  }
  return { slackKeys: [...keys], channels: [...channels], all };
}

type Refs = { threadIds?: readonly string[]; slackChannels?: readonly string[]; fps?: readonly string[]; refs?: readonly SourceRef[] };
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const refList = (v: unknown): SourceRef[] => (Array.isArray(v) ? (v as SourceRef[]) : []);

/** P8 fixer security-5: the fingerprints of the intake mechanisms' approvals lines (titles named from client mail). */
const INTAKE_FPS: ReadonlySet<string> = new Set([...INTAKE_APPROVALS].map(intakeApprovalFp));
const TASK_URL = /\/tasks\/[^/?#]+$/;

/** An intake approvals line's DD task ids (its task refs, which the line lists first); null when the line isn't one. */
function intakeTaskIds(x: Refs): string[] | null {
  if (!(x.fps ?? []).some((f) => INTAKE_FPS.has(f))) return null;
  return (x.refs ?? []).flatMap((r) => (r?.system === "dd" && typeof r.id === "string" && typeof r.url === "string" && TASK_URL.test(r.url) ? [r.id] : []));
}

/** Every intake approvals line's task ids in a content. */
function contentIntakeTaskIds(content: BriefContent): string[] {
  const out = new Set<string>();
  const add = (x: Refs) => {
    for (const id of intakeTaskIds(x) ?? []) out.add(id);
  };
  for (const s of content?.sections ?? []) {
    for (const i of s?.items ?? []) add({ fps: arr(i?.fps), refs: refList(i?.refs) });
    for (const p of s?.pending ?? []) add({ fps: arr([p?.fp]), refs: refList(p?.refs) });
  }
  for (const t of content?.top3 ?? []) add({ fps: arr([t?.fp]), refs: refList(t?.refs) });
  return [...out].sort();
}

/** The screen over one content, from a per-line verdict. A top-3 entry whose line is withheld goes too (as the scrub RPC drops it). */
function screenOf(content: BriefContent, verdict: (x: Refs) => "restricted" | "slack" | null, withheldThreadIds: readonly string[]): BriefScreen {
  const items = new Map<string, "restricted" | "slack">();
  const pending = new Set<string>();
  const top3 = new Set<string>();
  for (const s of content?.sections ?? []) {
    for (const i of s?.items ?? []) {
      const v = verdict({ threadIds: arr(i?.threadIds), slackChannels: arr(i?.slackChannels), fps: arr(i?.fps), refs: refList(i?.refs) });
      if (v !== null && typeof i.id === "string") items.set(i.id, v);
    }
    for (const p of s?.pending ?? []) {
      if (verdict({ threadIds: arr(p?.threadIds), slackChannels: arr(p?.slackChannels), fps: arr([p?.fp]), refs: refList(p?.refs) }) !== null
          && typeof p.fp === "string") pending.add(p.fp);
    }
  }
  for (const t of content?.top3 ?? []) {
    const v = verdict({ threadIds: arr(t?.threadIds), slackChannels: arr(t?.slackChannels), fps: arr([t?.fp]), refs: refList(t?.refs) });
    if ((v !== null || (typeof t?.itemId === "string" && items.has(t.itemId))) && typeof t.alias === "string") top3.add(t.alias);
  }
  if (items.size === 0 && pending.size === 0 && top3.size === 0) return NO_SCREEN;
  return { items, pending, top3, withheldThreadIds: [...withheldThreadIds], hideHeadline: true };
}

/** Pure. The page's answer to a failed screen read: every item, pending line and top-3 entry with threadIds withheld "restricted";
 *  Slack-derived ones withheld "slack" unless slackOk. Nothing is scrubbed into the row from it (withheldThreadIds stays empty). */
export function withholdAllEmail(content: BriefContent, slackOk: boolean): BriefScreen {
  // P8 fixer security-5: an intake approvals line (titles named from client mail) can't be screened either.
  return screenOf(content, (x) => ((x.threadIds?.length ?? 0) > 0 || intakeTaskIds(x) !== null ? "restricted"
    : !slackOk && (x.slackChannels?.length ?? 0) > 0 ? "slack" : null), []);
}

/** The job's (or the request's) own abort, as the caller should see it. */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The brief screen was aborted", "AbortError");
}

/**
 * C31. Email: loadScreeningPolicy + listThreadScreenRows(contentRefs(content).threadIds) + screenStoredRow: an item, pending line
 * or top-3 entry is withheld "restricted" when any of its threadIds is withheld or has no stored row. Slack: one
 * slackIntelState(principal, settings); not "ok" → everything with a slackChannels entry is withheld "slack". Any read failure →
 * { ok: false }. Never writes; rethrows only opts.signal's abort. A content citing no thread (or no Slack) reads nothing for it.
 */
export async function screenBriefContent(principal: ExecPrincipal, settings: ExecSettings, content: BriefContent,
  opts: { now: Date; signal?: AbortSignal }): Promise<{ ok: true; screen: BriefScreen } | { ok: false; reason: "screen_unavailable" }> {
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError(signal);
  const refs = contentRefs(content);
  const withheld = new Set<string>();
  const withheldTasks = new Set<string>();
  let slackOk = true;
  try {
    if (refs.threadIds.length > 0) {
      const policy = await loadScreeningPolicy(principal, { signal });
      const rows = await listThreadScreenRows(principal, refs.threadIds, { signal });
      for (const threadId of refs.threadIds) {
        const row = rows.get(threadId);
        if (!row || screenStoredRow(row, policy.rules, policy.hash).verdict !== "clean") withheld.add(threadId);
      }
    }
    // P8 fixer security-5: P5a's S5 again, now, over the intake approvals lines' tasks (a rule added since the build matches the
    // intake sender, or a linked thread was restricted or gone). It fails closed on its own (an unreadable link or rule → withheld).
    const taskIds = contentIntakeTaskIds(content);
    if (taskIds.length > 0) {
      const policy = await loadIntakeScreeningPolicy(principal, { signal });
      for (const taskId of (await restrictedIntakeTaskIds(principal, taskIds, policy, { signal })).keys()) withheldTasks.add(taskId);
    }
    if (refs.slackChannels.length > 0) slackOk = (await slackIntelState(principal, settings, { signal })) === "ok";
  } catch {
    if (signal?.aborted) throw abortError(signal);
    return { ok: false, reason: "screen_unavailable" };
  }
  const screen = screenOf(content, (x) => ((x.threadIds ?? []).some((t) => withheld.has(t)) || (intakeTaskIds(x) ?? []).some((t) => withheldTasks.has(t))
    ? "restricted" : !slackOk && (x.slackChannels?.length ?? 0) > 0 ? "slack" : null), [...withheld].sort());
  return { ok: true, screen };
}

type PurgeLogReader = (principal: ExecPrincipal, afterId: number, limit: number) =>
  Promise<{ id: number; scope: "message" | "conversation" | "reading"; channelId: string | null; ts: string | null }[]>;

/** P7a's listPurgeLog through the facade, or null when the facade doesn't carry it (P7a not built in this tree). */
function purgeLogReader(): PurgeLogReader | null {
  try {
    const fn = (slackReading as Record<string, unknown>).listPurgeLog;
    return typeof fn === "function" ? (fn as PurgeLogReader) : null;
  } catch {
    return null;
  }
}

/** One scrub per ≤ 500 keys and channels (the RPC's limit); `all` is one call that covers everything. */
async function scrubSlack(principal: ExecPrincipal, q: { slackKeys: string[]; channels: string[]; all: boolean }, signal?: AbortSignal): Promise<void> {
  if (q.all) {
    await scrubBriefsForSlack(principal, { slackKeys: [], channels: [], all: true }, { signal });
    return;
  }
  const n = Math.max(q.slackKeys.length, q.channels.length);
  for (let i = 0; i < n; i += BRIEF_LIMITS.scrubBatch) {
    signal?.throwIfAborted();
    await scrubBriefsForSlack(principal, {
      slackKeys: q.slackKeys.slice(i, i + BRIEF_LIMITS.scrubBatch), channels: q.channels.slice(i, i + BRIEF_LIMITS.scrubBatch), all: false
    }, { signal });
  }
}

/**
 * intel-13. Called by the build right after finishBuild (§3.11 step 9b) and by the deliver job before its CAS (§3.13.2 step 4b):
 * 1. afterId = getSyncState(principal, "brief", "slack-scrub").afterId (read, never moved here: the sweep owns it); up to
 *    purgeLogBatchesPerRun batches of listPurgeLog(principal, afterId, 200) → purgeLogScrubQuery → scrubBriefsForSlack (every brief of
 *    the principal that cites them; idempotent). The facade missing (P7a not built/applied) → this step is skipped.
 * 2. row = getBriefById(principal, briefId) (null → not_found); screen = screenBriefContent(row.content).
 * 3. screen.withheldThreadIds non-empty → scrubBriefsForThreads(principal, those ids) (the stored content loses the lines, not only
 *    this render), re-read the row and screen it again.
 * Any read or scrub failure → { ok: false, reason: "screen_unavailable" }. Rethrows only opts.signal's abort.
 */
export async function catchUpBriefScrubs(principal: ExecPrincipal, settings: ExecSettings, briefId: string,
  opts: { now: Date; signal?: AbortSignal }): Promise<{ ok: true; row: BriefRow; screen: BriefScreen } | { ok: false; reason: "screen_unavailable" | "not_found" }> {
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError(signal);
  const screenRow = async (row: BriefRow) =>
    row.content === null ? ({ ok: true, screen: NO_SCREEN } as const) : screenBriefContent(principal, settings, row.content, { now: opts.now, signal });
  try {
    const reader = purgeLogReader();
    if (reader !== null) {
      const cursor = await getSyncState(principal, "brief", "slack-scrub", parseSlackScrubCursor, { signal });
      let after = cursor?.value.afterId ?? 0;
      for (let batch = 0; batch < BRIEF_LIMITS.purgeLogBatchesPerRun; batch += 1) {
        signal?.throwIfAborted();
        const rows = await reader(principal, after, BRIEF_LIMITS.purgeLogBatch);
        if (!Array.isArray(rows) || rows.length === 0) break;
        await scrubSlack(principal, purgeLogScrubQuery(rows, principal.briefTimezone), signal);
        after = rows.reduce((max, r) => (typeof r.id === "number" && r.id > max ? r.id : max), after);
        if (rows.length < BRIEF_LIMITS.purgeLogBatch) break;
      }
    }
    let row = await getBriefById(principal, briefId, { signal });
    if (row === null) return { ok: false, reason: "not_found" };
    let screened = await screenRow(row);
    if (!screened.ok) return { ok: false, reason: "screen_unavailable" };
    if (screened.screen.withheldThreadIds.length > 0) {
      await scrubBriefsForThreads(principal, screened.screen.withheldThreadIds, { signal });
      row = await getBriefById(principal, briefId, { signal });
      if (row === null) return { ok: false, reason: "not_found" };
      screened = await screenRow(row);
      if (!screened.ok) return { ok: false, reason: "screen_unavailable" };
    }
    return { ok: true, row, screen: screened.screen };
  } catch {
    if (signal?.aborted) throw abortError(signal);
    return { ok: false, reason: "screen_unavailable" };
  }
}
