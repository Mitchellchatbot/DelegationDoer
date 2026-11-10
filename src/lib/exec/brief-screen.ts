import "server-only";

import { contentRefs, INTAKE_APPROVALS, intakeApprovalFp } from "@/lib/exec/brief-sections";
import { getBriefById, listBriefDigestKeys, scrubBriefsForSlack, scrubBriefsForThreads } from "@/lib/exec/brief-store";
import { BRIEF_LIMITS, slackDigestBriefKey, slackMessageBriefKey } from "@/lib/exec/brief-types";
import type { BriefContent, BriefRow } from "@/lib/exec/brief-types";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { localDateOfTs } from "@/lib/exec/slack-intel-types";
import type { ChannelRow } from "@/lib/exec/slack-read-types";
import * as slackReading from "@/lib/exec/slack-reading";
import { optoutFingerprint, parseOptoutState } from "@/lib/exec/slack-redact";
import { isPinnedAccount, loadScreeningPolicy, screenStoredRow } from "@/lib/exec/sources/mail";
import { getSyncState, parseSlackScrubCursor, putSyncState } from "@/lib/exec/sync-state";
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
//
// P9 (Area C):
//   * F4: an author opt-out (a Slack deletion request) can't be traced to the digest lines that paraphrase the author
//     (digests read live history, so no purge-log row names them). applyBriefOptoutScrubs, run by the brief sweep and by
//     the catch-up before a DM is rendered, scrubs every digest-derived line (d: keys) of his briefs for 30 minutes after
//     the opt-out set grows (exec_sync_state brief/optouts = { fp, count, changedAt }, C33's fingerprint).
//   * F7: a line citing a thread row on an account that is no longer pinned is withheld "unavailable" (render-time only:
//     the pin can be restored, so nothing is scrubbed into the row).
//   * F11: the render screen re-reads the cited Slack channel rows (listIntelChannels through the facade, once) and withholds
//     "slack" every line citing a channel that is missing, deny / hub / unclassified, left, finance (class or name), or not
//     watched (a message line may pass a mute only as the stored mute bypass would: an IM muted by him or Slack; a digest
//     line needs watched). A facade without the reader withholds every Slack line; a read failure is screen_unavailable.

/** Why a stored brief line is withheld at render. "unavailable" (P9 seed S2; contract F7/F11, Area C produces it): the line's
 *  source can no longer be shown here (for example a thread row on an account that is no longer pinned); it renders as
 *  BRIEF_COPY.removedUnavailable. */
export type BriefWithheldReason = "restricted" | "slack" | "unavailable";

export interface BriefScreen {
  /** BriefItem id → why it is withheld now. */
  items: ReadonlyMap<string, BriefWithheldReason>;
  /** Withheld pending lines (by fp) and top-3 entries (by alias). */
  pending: ReadonlySet<string>; top3: ReadonlySet<string>;
  /** P3 thread ids the screen withholds now (catchUpBriefScrubs scrubs them into the row). */
  withheldThreadIds: readonly string[];
  /** Anything withheld → the AI headline isn't shown (it cites no refs; intel-14). */
  hideHeadline: boolean;
}

export const NO_SCREEN: BriefScreen = Object.freeze({
  items: new Map<string, BriefWithheldReason>(),
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

type Refs = {
  threadIds?: readonly string[]; slackChannels?: readonly string[]; fps?: readonly string[]; refs?: readonly SourceRef[];
  /** P9 F11: m:<channel>:<ts> (a message line) and d:<channel>:<date> (a digest line). */
  slackKeys?: readonly string[];
};
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
function screenOf(content: BriefContent, verdict: (x: Refs) => BriefWithheldReason | null, withheldThreadIds: readonly string[]): BriefScreen {
  const items = new Map<string, BriefWithheldReason>();
  const pending = new Set<string>();
  const top3 = new Set<string>();
  for (const s of content?.sections ?? []) {
    for (const i of s?.items ?? []) {
      const v = verdict({ threadIds: arr(i?.threadIds), slackChannels: arr(i?.slackChannels), slackKeys: arr(i?.slackKeys), fps: arr(i?.fps),
        refs: refList(i?.refs) });
      if (v !== null && typeof i.id === "string") items.set(i.id, v);
    }
    for (const p of s?.pending ?? []) {
      if (verdict({ threadIds: arr(p?.threadIds), slackChannels: arr(p?.slackChannels), slackKeys: arr(p?.slackKeys), fps: arr([p?.fp]),
        refs: refList(p?.refs) }) !== null && typeof p.fp === "string") pending.add(p.fp);
    }
  }
  for (const t of content?.top3 ?? []) {
    const v = verdict({ threadIds: arr(t?.threadIds), slackChannels: arr(t?.slackChannels), slackKeys: arr(t?.slackKeys), fps: arr([t?.fp]),
      refs: refList(t?.refs) });
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

type ChannelReader = (principal: ExecPrincipal, opts?: { channelIds?: readonly string[]; signal?: AbortSignal }) => Promise<ChannelRow[]>;

/** P7a's listIntelChannels through the facade, or null when the facade doesn't carry it (the guarded accessor below). */
function intelChannelReader(): ChannelReader | null {
  try {
    const fn = (slackReading as Record<string, unknown>).listIntelChannels;
    return typeof fn === "function" ? (fn as ChannelReader) : null;
  } catch {
    return null;
  }
}

/** P9 F11: the cited channels' rows, one read; a facade without the reader → none (every Slack line is then withheld). Throws on a
 *  read failure (the caller's screen_unavailable). */
async function readCitedChannels(principal: ExecPrincipal, channelIds: readonly string[], signal: AbortSignal | undefined): Promise<ReadonlyMap<string, ChannelRow>> {
  const reader = intelChannelReader();
  if (reader === null) return new Map();
  const rows = await reader(principal, { channelIds, signal });
  return new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.channelId === "string").map((r) => [r.channelId, r]));
}

/**
 * P9 F11. Pure. Whether a line citing Slack may still be shown, from its channels' rows now (the gather read them through the
 * attention screen and the digest plan when the brief was built; any of them can have changed since). Every cited channel must
 * be present (listIntelChannels never returns a deny row), not hub or unclassified, not left, not finance (its class or its
 * name), and watched. A mute passes only for a message line (no d: key) in an IM muted by him or by Slack: the stored items of
 * an IM carry the mute bypass (every IM message is a DM to him, slack-ingest's REASON.dm), as slackScreenAllows requires; a
 * mention in a muted channel can't be told from the channel row, so it is withheld (fail closed). A digest line needs watched.
 */
export function slackLineShown(x: { slackChannels?: readonly string[]; slackKeys?: readonly string[] }, channels: ReadonlyMap<string, ChannelRow>): boolean {
  const keys = x.slackKeys ?? [];
  const messageLine = keys.length > 0 && keys.every((k) => k.startsWith("m:"));
  for (const id of x.slackChannels ?? []) {
    const ch = channels.get(id);
    if (!ch || ch.class === "deny" || ch.class === "hub" || ch.class === "unclassified") return false;
    if (ch.leftAt !== null) return false;
    if (ch.class === "finance" || ch.financeName === true) return false;
    if (ch.watchState === "watched") continue;
    const imBypass = ch.watchState === "muted" && (ch.muteSource === "owner" || ch.muteSource === "slack") && ch.convType === "im";
    if (!(messageLine && imBypass)) return false;
  }
  return true;
}

/**
 * C31. Email: loadScreeningPolicy + listThreadScreenRows(contentRefs(content).threadIds) + screenStoredRow: an item, pending line
 * or top-3 entry is withheld "restricted" when any of its threadIds is withheld or has no stored row; P9 F7: else "unavailable"
 * when any of its thread rows is on an account that is no longer pinned (P3 ui-3; render-time only, never scrubbed into the row).
 * Slack: one slackIntelState(principal, settings); not "ok" → everything with a slackChannels entry is withheld "slack"; P9 F11:
 * "ok" → one listIntelChannels read of the cited channels, and a line any of whose channels fails slackLineShown is withheld
 * "slack". Any read failure → { ok: false }. Never writes; rethrows only opts.signal's abort. A content citing no thread (or no
 * Slack) reads nothing for it.
 */
export async function screenBriefContent(principal: ExecPrincipal, settings: ExecSettings, content: BriefContent,
  opts: { now: Date; signal?: AbortSignal }): Promise<{ ok: true; screen: BriefScreen } | { ok: false; reason: "screen_unavailable" }> {
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError(signal);
  const refs = contentRefs(content);
  const withheld = new Set<string>();
  const unpinned = new Set<string>();
  const withheldTasks = new Set<string>();
  let slackOk = true;
  let channels: ReadonlyMap<string, ChannelRow> = new Map();
  try {
    if (refs.threadIds.length > 0) {
      const policy = await loadScreeningPolicy(principal, { signal });
      const rows = await listThreadScreenRows(principal, refs.threadIds, { signal });
      for (const threadId of refs.threadIds) {
        const row = rows.get(threadId);
        if (!row || screenStoredRow(row, policy.rules, policy.hash).verdict !== "clean") withheld.add(threadId);
        else if (!isPinnedAccount(principal, row.accountId)) unpinned.add(threadId);
      }
    }
    // P8 fixer security-5: P5a's S5 again, now, over the intake approvals lines' tasks (a rule added since the build matches the
    // intake sender, or a linked thread was restricted or gone). It fails closed on its own (an unreadable link or rule → withheld).
    const taskIds = contentIntakeTaskIds(content);
    if (taskIds.length > 0) {
      const policy = await loadIntakeScreeningPolicy(principal, { signal });
      for (const taskId of (await restrictedIntakeTaskIds(principal, taskIds, policy, { signal })).keys()) withheldTasks.add(taskId);
    }
    if (refs.slackChannels.length > 0) {
      slackOk = (await slackIntelState(principal, settings, { signal })) === "ok";
      if (slackOk) channels = await readCitedChannels(principal, refs.slackChannels, signal);
    }
  } catch {
    if (signal?.aborted) throw abortError(signal);
    return { ok: false, reason: "screen_unavailable" };
  }
  const screen = screenOf(content, (x): BriefWithheldReason | null => {
    if ((x.threadIds ?? []).some((t) => withheld.has(t)) || (intakeTaskIds(x) ?? []).some((t) => withheldTasks.has(t))) return "restricted";
    if ((x.threadIds ?? []).some((t) => unpinned.has(t))) return "unavailable";
    if ((x.slackChannels?.length ?? 0) > 0 && (!slackOk || !slackLineShown(x, channels))) return "slack";
    return null;
  }, [...withheld].sort());
  return { ok: true, screen };
}

// ---------------------------------------------------------------------------
// P9 F4: author opt-outs vs digest-derived brief lines
// ---------------------------------------------------------------------------

/** How long after the opt-out set grows every digest-derived line is scrubbed (a brief built meanwhile from a digest P7b hadn't
 *  blanked yet is caught; intel-13's pattern). */
export const OPTOUT_SCRUB_WINDOW_MS = 30 * 60_000;

/** exec_sync_state brief/optouts: C33's fingerprint of the opted-out authors (never the ids) and when the set last grew. */
export interface BriefOptoutState { fp: string; count: number; changedAt: string | null }

/** A stored brief/optouts state, or null when it doesn't parse (then the set is treated as new: fail closed). */
export function parseBriefOptoutState(raw: unknown): BriefOptoutState | null {
  const base = parseOptoutState(raw);
  if (base === null) return null;
  const c = (raw as { changedAt?: unknown }).changedAt;
  if (c !== null && c !== undefined && (typeof c !== "string" || !Number.isFinite(Date.parse(c)))) return null;
  return { fp: base.fp, count: base.count, changedAt: typeof c === "string" ? new Date(Date.parse(c)).toISOString() : null };
}

type OptoutLister = (principal: ExecPrincipal) => Promise<string[]>;

/** P7a's listAuthorOptouts through the facade, or null when the facade doesn't carry it (the guarded accessor, as listPurgeLog). */
function optoutLister(): OptoutLister | null {
  try {
    const fn = (slackReading as Record<string, unknown>).listAuthorOptouts;
    return typeof fn === "function" ? (fn as OptoutLister) : null;
  } catch {
    return null;
  }
}

/**
 * P9 F4 (contract §1 F4 step 3). An author opt-out can't be traced to the digest lines that paraphrase the author, so when the
 * opt-out set grows (the fingerprint moved and the count didn't shrink) changedAt = now, and for OPTOUT_SCRUB_WINDOW_MS after it
 * every call scrubs all of the principal's d: keys (listBriefDigestKeys) through scrubBriefsForSlack in chunks of ≤ 500 (each
 * scrubbed row gets scrubbed_at, so C15 replaces its DM). The new state is stored only after every chunk succeeded (a failure
 * throws and the next call retries); a shrinking set stores its fingerprint and opens no window (one already open runs to its
 * end). Nothing is written while the set is empty and nothing was stored. Run by the brief sweep (its "optouts" step) and by the
 * catch-up before a DM is rendered. null when the facade doesn't carry listAuthorOptouts. Counts only.
 */
export async function applyBriefOptoutScrubs(principal: ExecPrincipal, now: Date, signal?: AbortSignal):
  Promise<{ scrubbed: number; window: boolean } | null> {
  const list = optoutLister();
  if (list === null) return null;
  const { fp, count } = optoutFingerprint(await list(principal));
  signal?.throwIfAborted();
  const stored = await getSyncState(principal, "brief", "optouts", parseBriefOptoutState, { signal });
  const prev: BriefOptoutState = stored?.value ?? { fp: "", count: 0, changedAt: null };
  let changedAt = prev.changedAt;
  if (fp !== prev.fp && count > 0 && count >= prev.count) changedAt = now.toISOString();
  const age = changedAt === null ? Number.NaN : now.getTime() - Date.parse(changedAt);
  const window = Number.isFinite(age) && age >= 0 && age < OPTOUT_SCRUB_WINDOW_MS;
  let scrubbed = 0;
  if (window) {
    const keys = await listBriefDigestKeys(principal, { signal });
    for (let i = 0; i < keys.length; i += BRIEF_LIMITS.scrubBatch) {
      signal?.throwIfAborted();
      scrubbed += (await scrubBriefsForSlack(principal, { slackKeys: keys.slice(i, i + BRIEF_LIMITS.scrubBatch), channels: [], all: false }, { signal })) ?? 0;
    }
  }
  const changed = fp !== prev.fp || changedAt !== prev.changedAt;
  if (changed && (stored !== null || count > 0)) {
    await putSyncState(principal, "brief", "optouts", { fp, count, changedAt }, { signal });
  }
  return { scrubbed, window };
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
 * 1b. P9 F4: applyBriefOptoutScrubs (a pending author opt-out scrubs the digest-derived lines before the DM is rendered; the
 *    facade missing listAuthorOptouts → skipped).
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
    // P9 F4: a pending author opt-out, before the row is read (its scrubs land in the row the DM is rendered from).
    await applyBriefOptoutScrubs(principal, opts.now, signal);
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
