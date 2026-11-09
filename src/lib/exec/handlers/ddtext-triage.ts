import "server-only";

import { listAttentionStatusByFingerprints, syncAttention } from "@/lib/exec/attention";
import type { AttentionStatus } from "@/lib/exec/attention-types";
import {
  deleteAllDdtextData,
  deleteDdtextItems,
  deleteDdtextItemsForTasks,
  getDdtextCursor,
  listDdtextItemsByKeys,
  listDdtextSignalTaskIds,
  listDeferredDdtextItems,
  listLiveDdtextSignals,
  purgeOrphanDdtextAttention,
  saveDdtextCursor,
  writeDdtextItem,
  type DdtextCursor,
  type DdtextItemWrite,
  type DdtextSignalWrite
} from "@/lib/exec/ddtext-store";
import {
  DDTEXT_ATTENTION_KINDS,
  DDTEXT_LIVE_DAYS,
  DDTEXT_VERSION,
  type DdtextFailure,
  type DdtextItem,
  type DdtextItemRow,
  type DdtextOutcome,
  type DdtextSignalRow,
  type DdtextSourceType
} from "@/lib/exec/ddtext-types";
import { loadIntakeScreeningPolicy, restrictedIntakeTaskIds, type IntakeWithholdReason } from "@/lib/exec/intake-screen";
import { spentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { ddMentionFingerprint } from "@/lib/exec/producers/dd";
import { buildDdtextCandidates, heldFingerprints } from "@/lib/exec/producers/ddtext";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import {
  listActivitySince,
  listTaskMessagesSince,
  listTasksByIds,
  listUpdateRepliesByUser,
  listUsers
} from "@/lib/exec/sources/dd";
import {
  listActivityTextByIds,
  listActivityTextSince,
  listEarlierCommentText,
  listNoteBlockersByIds,
  listSubmittedNoteBlockersSince,
  type DdNoteBlockers,
  type DdTextActivity
} from "@/lib/exec/sources/dd-text";
import type { DdTask, DdUser } from "@/lib/exec/sources/dd-types";
import { releaseLease, tryAcquireLease } from "@/lib/exec/sync-state";
import { newNonce } from "@/lib/exec/text/untrusted";
import {
  ddtextContentHash,
  ddtextOutcomes,
  ddtextSourceTypeOf,
  mentionsPrincipal,
  noteDdtextBatch,
  packDdtextBatches,
  prefilterDdtext,
  renderDdtextBatch,
  runDdtextModel,
  type DdtextBatch,
  type ParsedDdtextSignal
} from "@/lib/exec/triage/ddtext";
import { NonRetryableError, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.ddtext-triage: the DD text triage (P5a contract §3.12.6, A5, C17, C25,
// C29, K17, K28; Area D). Every 10 minutes on the bulk lane, on the same
// interval buckets as exec.dd-attention but its own kind, so Haiku latency and
// failures never hold the DD attention refresh.
//
//   1. Gate: not installed → skip; turned off → delete every item, signal and
//      ddtext attention row of the principal (any status) and stop. Ungated
//      schedule, so turning triage off empties it on the next run.
//   2. A lease (ddtext/ddtext-lease): one run at a time per principal.
//   3-6. What to triage: new comment-class activity (comments, status-change
//      notes, handoff notes, extension reasons) since the cursor, submitted
//      EOD/SOD blockers unedited since submission, and items deferred by the
//      budget; each key at most once per run. Every task behind them goes
//      through the restricted-sender verdict first (C25): a withheld task's
//      text never reaches the model.
//   7. Triage: at most 3 calls at once; stop launching at 180 s, at 60 calls,
//      at the daily cost cap (P2a) or at this feature's $1/day ceiling (C29),
//      where every unlaunched item is written deferred.
//   8. The cursor: each position advances to the last row in scan order that is
//      written, skipped, deduped or deferred, never past an unlaunched item or
//      an unscreened task's row; saved with this run's start (ddtextLastRunAt).
//   9. Attention: the live signals become candidates for syncAttention, after
//      the tasks behind them are screened again (a sender muted later drops
//      their signals); then every ddtext attention row no signal backs, or
//      past 14 days, is deleted.
//
// Logs, the job result and every return value carry ids, counts and codes
// only (boundary rule 9b). DD text lives in memory for the model call.

export const DDTEXT_JOB_KIND = "exec.ddtext-triage";

/** C29: the feature's own daily ceiling, and the margin kept for calls still in flight. */
export const DDTEXT_DAILY_CEILING_USD = 1;
export const DDTEXT_CALL_MARGIN_USD = 0.01;

const TIMEOUT_MS = 240_000;
const EVERY_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const LEASE_TTL_MS = 300_000;
/** The run stops launching calls after this long (the job's timeout is 240 s). */
export const DDTEXT_TIME_BOX_MS = 180_000;
export const DDTEXT_MAX_CALLS = 60;
export const DDTEXT_MAX_ITEMS = 200;
export const DDTEXT_MAX_SCAN_ROWS = 2000;
export const DDTEXT_CONCURRENCY = 3;
/** Every scan re-reads this much before its position, for rows committed late. */
export const DDTEXT_OVERLAP_MS = 15 * 60_000;
/** The backfill and scan floor: min(14, retention_days_ddtext) days (a-correct-15). */
export const DDTEXT_WINDOW_DAYS = 14;
const CONTEXT_ROWS = 5;
const DAY_MS = 86_400_000;

/** What a run returns: counts only (§3.12.6 step 10). */
export interface DdtextRunCounts {
  scanned: number;
  prefiltered: number;
  deduped: number;
  skippedIntake: number;
  skippedUnscreened: number;
  skippedEditedAfterSubmit: number;
  items: number;
  calls: number;
  signals: number;
  failed: number;
  deferred: number;
  ceilingReached: number;
  sourceGone: number;
  rejected: number;
  withheldDeleted: number;
  inserted: number;
  updated: number;
  reopened: number;
  resolved: number;
  unchanged: number;
  orphansDeleted: number;
}

function zeroCounts(): DdtextRunCounts {
  return {
    scanned: 0,
    prefiltered: 0,
    deduped: 0,
    skippedIntake: 0,
    skippedUnscreened: 0,
    skippedEditedAfterSubmit: 0,
    items: 0,
    calls: 0,
    signals: 0,
    failed: 0,
    deferred: 0,
    ceilingReached: 0,
    sourceGone: 0,
    rejected: 0,
    withheldDeleted: 0,
    inserted: 0,
    updated: 0,
    reopened: 0,
    resolved: 0,
    unchanged: 0,
    orphansDeleted: 0
  };
}

const keyOf = (sourceType: DdtextSourceType, sourceId: string) => `${sourceType}:${sourceId}`;
const isNoteType = (t: DdtextSourceType) => t === "eod_note" || t === "sod_note";
const isCommentClass = (t: DdtextSourceType) => t === "comment" || t === "status_comment";
const PERMANENT_WITHHOLD: ReadonlySet<IntakeWithholdReason> = new Set(["restricted_sender", "restricted_thread", "thread_gone"]);

function ms(iso: string | null | undefined): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

/** A row in scan order, for the cursor: blocked rows hold it. */
interface SeqRow {
  at: string;
  id: string;
  key: string | null;
  blocked: boolean;
}

/** The last row before the first blocked one (or the last row); null when the first row is blocked or there are none. */
function advance(seq: readonly SeqRow[], done: ReadonlySet<string>): SeqRow | null {
  let last: SeqRow | null = null;
  for (const r of seq) {
    if (r.blocked || (r.key !== null && !done.has(r.key))) break;
    last = r;
  }
  return last;
}

/** Two raw positions in scan order: by time, a same-millisecond tie by the raw strings (they carry the microseconds, as sources/dd-text cmpTime). */
function cmpAt(a: string, b: string): number {
  const x = ms(a.replace(" ", "T"));
  const y = ms(b.replace(" ", "T"));
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Review data-3: a position never moves backwards (§3.12.6 step 8, each
 * position "advances"). Every scan re-reads the 15-minute overlap before the
 * saved position, and a row there that now blocks (a task the screen can't
 * check during a rules or store outage, an overlap note over the item cap)
 * was accounted for by an earlier run: advance() stopping before it would
 * walk the cursor back up to 15 minutes per run. Such a row stays in the next
 * scan anyway, since the position can't pass it. The comparison is (at, id)
 * for comments and at for notes.
 */
function forwardComments(next: SeqRow | null, saved: DdtextCursor["comments"]): DdtextCursor["comments"] {
  if (next === null) return saved;
  if (saved.at !== null) {
    const c = cmpAt(next.at, saved.at) || (saved.id === null ? 0 : next.id < saved.id ? -1 : next.id > saved.id ? 1 : 0);
    if (c <= 0) return saved;
  }
  return { at: next.at, id: next.id };
}

function forwardNote(next: SeqRow | null, saved: DdtextCursor["eod"]): DdtextCursor["eod"] {
  if (next === null) return saved;
  if (saved.at !== null && cmpAt(next.at, saved.at) <= 0) return saved;
  return { at: next.at };
}

/** What one candidate item becomes: a model call, a mention-only write, or a "none" write. */
interface Pending {
  item: DdtextItem;
  key: string;
  task: DdTask | null;
  mode: "model" | "mention_only" | "none";
}

async function runDdtextTriage(ctx: JobContext): Promise<Record<string, unknown>> {
  const { principal, signal, job } = ctx;
  if (!principal) throw new NonRetryableError(`${DDTEXT_JOB_KIND}: the job has no principal`);
  const settings = await loadSettings(principal.id);
  if (!settings.ddtextSchemaReady) return { skipped: "not_installed" };
  if (!settings.ddtextEnabled) {
    // a-build-12: off means nothing of it stays. The cursor is kept, so turning it on resumes (never further back than W).
    const gone = await deleteAllDdtextData(principal, { signal });
    return { disabled: true, deletedItems: gone.items, deletedAttention: gone.attentionRows };
  }
  const holder = `${ctx.workerId}:${job.id}`;
  const now = new Date();
  if (!(await tryAcquireLease(principal, "ddtext-lease", holder, LEASE_TTL_MS, now))) return { skipped: "lease_held" };
  try {
    return await triageRun(principal, settings.retentionDaysDdtext, now, signal);
  } finally {
    await releaseLease(principal, "ddtext-lease", holder);
  }
}

async function triageRun(principal: ExecPrincipal, retentionDays: number, now: Date, signal: AbortSignal): Promise<Record<string, unknown>> {
  const counts = zeroCounts();
  const startMs = Date.now();
  const nowMs = now.getTime();
  const startedAt = now.toISOString();
  const keepDays = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90;
  const floorMs = nowMs - Math.min(DDTEXT_WINDOW_DAYS, keepDays) * DAY_MS;
  const floorIso = new Date(floorMs).toISOString();
  const scanStart = (at: string | null) => new Date(Math.max((Number.isFinite(ms(at)) ? ms(at) : floorMs) - DDTEXT_OVERLAP_MS, floorMs)).toISOString();
  const read = { signal };

  // 3. The cursor; a first run starts every position at the floor.
  const saved = await getDdtextCursor(principal, read);
  const position: DdtextCursor = saved?.value ?? { comments: { at: floorIso, id: null }, eod: { at: floorIso }, sod: { at: floorIso }, startedAt };
  const queued = new Set<string>();
  const done = new Set<string>();
  // Notes this run already counted as edited after submission (step 5), so step 6 doesn't count them twice.
  const editedSeen = new Set<string>();
  const mentionKeys = new Set<string>();
  let modelItems = 0;

  let users: DdUser[] | null = null;
  const loadUsers = async () => (users ??= await listUsers(principal, read));
  const authorNames = async () => new Map((await loadUsers()).map((u) => [u.id, u.name]));
  const policyRef: { value: Awaited<ReturnType<typeof loadIntakeScreeningPolicy>> | undefined } = { value: undefined };
  const policy = async () => {
    if (policyRef.value === undefined) policyRef.value = await loadIntakeScreeningPolicy(principal, read);
    return policyRef.value;
  };

  const pending: Pending[] = [];
  const itemOf = (p: {
    sourceType: DdtextSourceType;
    sourceId: string;
    taskId: string | null;
    authorUserId: string;
    sourceCreatedAt: string;
    noteDate: string | null;
    text: string;
    mention: boolean;
  }): DdtextItem => ({
    ref: "",
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    taskId: p.taskId,
    authorUserId: p.authorUserId,
    sourceCreatedAt: p.sourceCreatedAt,
    noteDate: p.noteDate,
    text: p.text,
    contentHash: ddtextContentHash(p.sourceType, p.sourceId, p.text),
    mentionsPrincipal: p.mention
  });
  /** Queue an item (once per run); false when the item cap leaves it for the next run. */
  const enqueue = (item: DdtextItem, task: DdTask | null, mode: Pending["mode"]): boolean => {
    const key = keyOf(item.sourceType, item.sourceId);
    if (mode === "model") {
      if (modelItems >= DDTEXT_MAX_ITEMS) return false;
      modelItems += 1;
    }
    queued.add(key);
    if (item.mentionsPrincipal) mentionKeys.add(key);
    counts.items += 1;
    pending.push({ item, key, task, mode });
    return true;
  };

  // 4. Comments (incl. status-change notes, handoff notes, extension reasons).
  const commentSince = scanStart(position.comments.at);
  let scan = await listActivityTextSince(principal, commentSince, { after: null, maxRows: DDTEXT_MAX_SCAN_ROWS, signal });
  const positionMs = ms(position.comments.at);
  const lastRead = scan.rows[scan.rows.length - 1];
  if (scan.hasMore && position.comments.id !== null && position.comments.at !== null && lastRead && ms(lastRead.createdAt) <= positionMs) {
    // The overlap alone filled the read: continue from the saved position instead, so the cursor can move.
    scan = await listActivityTextSince(principal, commentSince, { after: { at: position.comments.at, id: position.comments.id }, maxRows: DDTEXT_MAX_SCAN_ROWS, signal });
  }
  counts.scanned += scan.rows.length;
  const commentSeq: SeqRow[] = [];
  {
    const tasks = await listTasksByIds(principal, [...new Set(scan.rows.map((r) => r.taskId))], read);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const live = tasks.filter((t) => !t.isDraft && t.deletedAt === null).map((t) => t.id);
    const withheld = live.length > 0 ? await restrictedIntakeTaskIds(principal, live, await policy(), read) : new Map<string, IntakeWithholdReason>();
    const candidates: { row: DdTextActivity; item: DdtextItem; task: DdTask; mode: Pending["mode"]; seq: SeqRow }[] = [];
    for (const row of scan.rows) {
      const type = ddtextSourceTypeOf(row.action);
      const key = keyOf(type, row.id);
      const seq: SeqRow = { at: row.createdAt, id: row.id, key: null, blocked: false };
      commentSeq.push(seq);
      const task = taskById.get(row.taskId);
      if (!task || task.isDraft || task.deletedAt !== null) {
        counts.prefiltered += 1;
        continue;
      }
      const verdict = withheld.get(task.id);
      if (verdict === "unscreened") {
        counts.skippedUnscreened += 1;
        seq.blocked = true;
        continue;
      }
      if (verdict !== undefined) {
        counts.skippedIntake += 1;
        continue;
      }
      const mention = isCommentClass(type) && !row.mentionedUserIds.includes(principal.userId) && mentionsPrincipal(row.text, principal);
      const verdictText = prefilterDdtext({ authorUserId: row.userId, text: row.text }, principal.userId);
      if (verdictText === "own" || verdictText === "empty" || (verdictText !== "keep" && !mention)) {
        counts.prefiltered += 1;
        continue;
      }
      const item = itemOf({ sourceType: type, sourceId: row.id, taskId: task.id, authorUserId: row.userId, sourceCreatedAt: row.createdAt, noteDate: null, text: row.text, mention });
      candidates.push({ row, item, task, mode: verdictText === "keep" ? "model" : "mention_only", seq });
      seq.key = key;
    }
    const stored = await listDdtextItemsByKeys(principal, candidates.map((c) => ({ sourceType: c.item.sourceType, sourceId: c.item.sourceId })), read);
    for (const c of candidates) {
      const key = keyOf(c.item.sourceType, c.item.sourceId);
      const before = stored.get(key);
      if ((before && before.contentHash === c.item.contentHash && before.outcome !== "deferred") || queued.has(key)) {
        counts.deduped += 1;
        c.seq.key = null;
        continue;
      }
      if (!enqueue(c.item, c.task, c.mode)) c.seq.blocked = true;
    }
  }

  // 5. Notes: submitted EOD/SOD blockers, unedited since submission (K28).
  const noteSeq: Record<"eod" | "sod", SeqRow[]> = { eod: [], sod: [] };
  for (const kind of ["eod", "sod"] as const) {
    const res = await listSubmittedNoteBlockersSince(principal, kind, scanStart(position[kind].at), read);
    counts.scanned += res.rows.length + res.editedAfterSubmit.length;
    counts.skippedEditedAfterSubmit += res.editedAfterSubmit.length;
    const type: DdtextSourceType = kind === "eod" ? "eod_note" : "sod_note";
    for (const id of res.editedAfterSubmit) editedSeen.add(keyOf(type, id));
    const candidates: { item: DdtextItem; seq: SeqRow }[] = [];
    for (const row of res.rows) {
      const seq: SeqRow = { at: row.submittedAt, id: row.id, key: null, blocked: false };
      noteSeq[kind].push(seq);
      if (prefilterDdtext({ authorUserId: row.userId, text: row.text }, principal.userId) !== "keep") {
        counts.prefiltered += 1;
        continue;
      }
      seq.key = keyOf(type, row.id);
      candidates.push({ item: noteItem(row, type, itemOf), seq });
    }
    const stored = await listDdtextItemsByKeys(principal, candidates.map((c) => ({ sourceType: c.item.sourceType, sourceId: c.item.sourceId })), read);
    for (const c of candidates) {
      const key = keyOf(c.item.sourceType, c.item.sourceId);
      const before = stored.get(key);
      if ((before && before.contentHash === c.item.contentHash && before.outcome !== "deferred") || queued.has(key)) {
        counts.deduped += 1;
        c.seq.key = null;
        continue;
      }
      if (!enqueue(c.item, null, "model")) c.seq.blocked = true;
    }
  }

  // 6. Deferred items (budget or ceiling, earlier runs), minus everything already queued this run.
  const room = DDTEXT_MAX_ITEMS - modelItems;
  if (room > 0) {
    const deferred = (await listDeferredDdtextItems(principal, floorIso, room, read)).filter((d) => !queued.has(keyOf(d.sourceType, d.sourceId)));
    await requeueDeferred(principal, deferred, { read, policy, enqueue, itemOf, counts, editedSeen });
  }

  // 7. Triage. Batches: one task's model items packed with context, or one note.
  const names = await authorNames();
  const batches: DdtextBatch[] = [];
  const taskItems = new Map<string, { task: DdTask; items: DdtextItem[] }>();
  for (const p of pending) {
    if (p.mode !== "model") continue;
    if (isNoteType(p.item.sourceType)) {
      batches.push(noteDdtextBatch(p.item, names, newNonce()));
    } else if (p.task !== null) {
      const group = taskItems.get(p.task.id) ?? { task: p.task, items: [] };
      group.items.push(p.item);
      taskItems.set(p.task.id, group);
    }
  }
  const taskBatches: DdtextBatch[] = [];
  for (const { task, items } of taskItems.values()) {
    items.sort((a, b) => ms(a.sourceCreatedAt) - ms(b.sourceCreatedAt) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
    const context = await listEarlierCommentText(principal, task.id, items[0].sourceCreatedAt, CONTEXT_ROWS, read);
    taskBatches.push(...packDdtextBatches({ task, items, context, authorNames: names, newNonce, tz: principal.timezone }));
  }
  batches.unshift(...taskBatches);

  const expiresFor = (sourceCreatedAt: string) => new Date((Number.isFinite(ms(sourceCreatedAt)) ? ms(sourceCreatedAt) : nowMs) + keepDays * DAY_MS).toISOString();
  const write = async (item: DdtextItem, outcome: DdtextOutcome, failure: DdtextFailure | null, found: readonly ParsedDdtextSignal[], model: string | null) => {
    const key = keyOf(item.sourceType, item.sourceId);
    const mention = mentionKeys.has(key);
    const rows: DdtextSignalWrite[] = [
      ...(mention ? [{ kind: "mention" as const, summary: null, confidence: "deterministic" as const }] : []),
      ...found.map((s) => ({ kind: s.kind, summary: s.summary, confidence: s.confidence }))
    ];
    const finalOutcome: DdtextOutcome = outcome === "none" && rows.length > 0 ? "signals" : outcome;
    const w: DdtextItemWrite = {
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      activityLogId: isNoteType(item.sourceType) ? null : item.sourceId,
      eodNoteId: item.sourceType === "eod_note" ? item.sourceId : null,
      sodNoteId: item.sourceType === "sod_note" ? item.sourceId : null,
      taskId: isNoteType(item.sourceType) ? null : item.taskId,
      authorUserId: item.authorUserId,
      sourceCreatedAt: item.sourceCreatedAt,
      noteDate: isNoteType(item.sourceType) ? item.noteDate : null,
      outcome: finalOutcome,
      failure: finalOutcome === "failed" ? failure : null,
      contentHash: item.contentHash,
      model,
      triageVersion: DDTEXT_VERSION,
      expiresAt: expiresFor(item.sourceCreatedAt)
    };
    try {
      const r = await writeDdtextItem(principal, w, rows, read);
      if (r === "source_gone") counts.sourceGone += 1;
      else {
        counts.signals += rows.length;
        if (finalOutcome === "failed") counts.failed += 1;
        if (finalOutcome === "deferred") counts.deferred += 1;
      }
    } catch (err) {
      if (!(err instanceof NonRetryableError)) throw err;
      counts.rejected += 1;
    }
    done.add(key);
  };

  // Writes that need no model call: mention-only items, and re-read deferred items that no longer qualify.
  for (const p of pending) {
    if (p.mode === "mention_only") await write(p.item, "none", null, [], null);
    else if (p.mode === "none") await write(p.item, "none", null, [], null);
  }

  let stop: null | "budget" | "ceiling" | "limit" = null;
  const deferAll = async (list: readonly DdtextBatch[], why: "budget" | "ceiling") => {
    for (const b of list) {
      for (const item of b.items) {
        if (done.has(keyOf(item.sourceType, item.sourceId))) continue;
        await write(item, "deferred", null, [], null);
        if (why === "ceiling") counts.ceilingReached += 1;
      }
    }
  };
  /** Before a launch: the time box, the call cap, the C29 ceiling (a failed spend read counts as reached). */
  const mayLaunch = async (): Promise<boolean> => {
    if (stop !== null) return false;
    if (Date.now() - startMs >= DDTEXT_TIME_BOX_MS || counts.calls >= DDTEXT_MAX_CALLS) {
      stop = "limit";
      return false;
    }
    let spent: number;
    try {
      spent = await spentTodayUsd(principal.id, principal.timezone, new Date(), { feature: "ddtext" });
    } catch (err) {
      signal.throwIfAborted();
      console.warn(`[exec-ddtext] ${principal.id}: today's ddtext spend couldn't be read (${err instanceof Error ? err.name : "error"}); deferring`);
      spent = Number.POSITIVE_INFINITY;
    }
    if (!(spent + DDTEXT_CALL_MARGIN_USD < DDTEXT_DAILY_CEILING_USD)) {
      stop = "ceiling";
      return false;
    }
    counts.calls += 1;
    return true;
  };

  const runBatch = async (batch: DdtextBatch, retrying: boolean): Promise<void> => {
    const rendered = renderDdtextBatch(batch, principal, now);
    const result = await runDdtextModel(principal, batch, { signal, now });
    if (result.kind === "budget") {
      stop = "budget";
      await deferAll([batch], "budget");
      return;
    }
    if (result.kind === "truncated" && !retrying && (batch.items.length > 1 || batch.context.length > 0)) {
      // One split retry: each item alone, without context.
      for (const item of batch.items) {
        if (!(await mayLaunch())) {
          if (stop === "budget" || stop === "ceiling") await deferAll([{ ...batch, items: [item] }], stop);
          continue;
        }
        await runBatch({ ...batch, items: [{ ...item, ref: "i1" }], context: [], nonce: newNonce() }, true);
      }
      return;
    }
    const outcomes = ddtextOutcomes(batch, rendered, result);
    const model = result.kind === "input_too_large" ? null : result.model;
    for (const item of batch.items) {
      const o = outcomes.get(item.ref);
      // An item the block didn't show gets no outcome and stays unlaunched (only a packing bug could cause it).
      if (!o) continue;
      await write(item, o.outcome, o.failure, o.signals, model);
    }
  };

  let next = 0;
  let thrown: unknown = null;
  const inFlight = new Set<Promise<void>>();
  while (next < batches.length && thrown === null) {
    if (inFlight.size >= DDTEXT_CONCURRENCY) {
      await Promise.race(inFlight);
      continue;
    }
    if (!(await mayLaunch())) break;
    const batch = batches[next];
    next += 1;
    const p: Promise<void> = runBatch(batch, false)
      .catch((err: unknown) => {
        if (thrown === null) thrown = err;
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.all([...inFlight]);
  // Infrastructure errors (and the job's abort) are the runner's: no cursor write, no sync.
  if (thrown !== null) throw thrown;
  if (stop === "budget" || stop === "ceiling") await deferAll(batches.slice(next), stop);

  // 8. The cursor.
  const moved = (seq: readonly SeqRow[]) => advance(seq, done);
  const c = moved(commentSeq);
  const e = moved(noteSeq.eod);
  const s = moved(noteSeq.sod);
  const cursor: DdtextCursor = {
    comments: forwardComments(c, position.comments),
    eod: forwardNote(e, position.eod),
    sod: forwardNote(s, position.sod),
    startedAt
  };
  if (!(await saveDdtextCursor(principal, saved?.rev ?? null, cursor, read))) {
    console.warn(`[exec-ddtext] ${principal.id}: the cursor moved under this run; the next run re-reads the overlap`);
  }

  // 9. Attention.
  await syncDdtextAttention(principal, now, counts, { read, loadUsers, policy: async () => loadIntakeScreeningPolicy(principal, read) });
  return { ...counts };
}

function noteItem(
  row: DdNoteBlockers,
  type: DdtextSourceType,
  itemOf: (p: {
    sourceType: DdtextSourceType;
    sourceId: string;
    taskId: string | null;
    authorUserId: string;
    sourceCreatedAt: string;
    noteDate: string | null;
    text: string;
    mention: boolean;
  }) => DdtextItem
): DdtextItem {
  return itemOf({ sourceType: type, sourceId: row.id, taskId: null, authorUserId: row.userId, sourceCreatedAt: row.submittedAt, noteDate: row.noteDate, text: row.text, mention: false });
}

/** Step 6: re-read deferred items by id, screen them again, and queue what still qualifies. */
async function requeueDeferred(
  principal: ExecPrincipal,
  deferred: readonly DdtextItemRow[],
  deps: {
    read: { signal: AbortSignal };
    policy: () => Promise<Awaited<ReturnType<typeof loadIntakeScreeningPolicy>>>;
    enqueue: (item: DdtextItem, task: DdTask | null, mode: Pending["mode"]) => boolean;
    itemOf: Parameters<typeof noteItem>[2];
    counts: DdtextRunCounts;
    editedSeen: ReadonlySet<string>;
  }
): Promise<void> {
  const { read, counts } = deps;
  const drop: { sourceType: DdtextSourceType; sourceId: string }[] = [];
  const activity = deferred.filter((d) => !isNoteType(d.sourceType));
  if (activity.length > 0) {
    const rows = await listActivityTextByIds(principal, activity.map((d) => d.sourceId), read);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const tasks = await listTasksByIds(principal, [...new Set(rows.map((r) => r.taskId))], read);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const live = tasks.filter((t) => !t.isDraft && t.deletedAt === null).map((t) => t.id);
    const withheld = live.length > 0 ? await restrictedIntakeTaskIds(principal, live, await deps.policy(), read) : new Map<string, IntakeWithholdReason>();
    for (const d of activity) {
      const row = byId.get(d.sourceId);
      // A deleted activity row took its item with it (the typed FK).
      if (!row) continue;
      const type = ddtextSourceTypeOf(row.action);
      const task = taskById.get(row.taskId);
      if (!task || task.isDraft || task.deletedAt !== null || type !== d.sourceType) {
        drop.push({ sourceType: d.sourceType, sourceId: d.sourceId });
        counts.prefiltered += 1;
        continue;
      }
      const verdict = withheld.get(task.id);
      if (verdict === "unscreened") {
        counts.skippedUnscreened += 1;
        continue;
      }
      if (verdict !== undefined && PERMANENT_WITHHOLD.has(verdict)) {
        drop.push({ sourceType: d.sourceType, sourceId: d.sourceId });
        counts.skippedIntake += 1;
        continue;
      }
      const mention = isCommentClass(type) && !row.mentionedUserIds.includes(principal.userId) && mentionsPrincipal(row.text, principal);
      const verdictText = prefilterDdtext({ authorUserId: row.userId, text: row.text }, principal.userId);
      const item = deps.itemOf({ sourceType: type, sourceId: row.id, taskId: task.id, authorUserId: row.userId, sourceCreatedAt: row.createdAt, noteDate: null, text: row.text, mention });
      deps.enqueue(item, task, verdictText === "keep" ? "model" : mention ? "mention_only" : "none");
    }
  }
  for (const kind of ["eod", "sod"] as const) {
    const type: DdtextSourceType = kind === "eod" ? "eod_note" : "sod_note";
    const notes = deferred.filter((d) => d.sourceType === type);
    if (notes.length === 0) continue;
    const res = await listNoteBlockersByIds(principal, kind, notes.map((d) => d.sourceId), read);
    // K28: a note edited after submission loses its deferred item; a resubmit brings it back through step 5.
    for (const id of res.editedAfterSubmit) {
      drop.push({ sourceType: type, sourceId: id });
      if (!deps.editedSeen.has(keyOf(type, id))) counts.skippedEditedAfterSubmit += 1;
    }
    for (const row of res.rows) {
      const item = noteItem(row, type, deps.itemOf);
      deps.enqueue(item, null, prefilterDdtext({ authorUserId: row.userId, text: row.text }, principal.userId) === "keep" ? "model" : "none");
    }
  }
  if (drop.length > 0) await deleteDdtextItems(principal, drop, read);
}

/** Step 9: live signals → candidates → syncAttention → the orphan purge. Any read failure throws before the sync. */
async function syncDdtextAttention(
  principal: ExecPrincipal,
  now: Date,
  counts: DdtextRunCounts,
  deps: {
    read: { signal: AbortSignal };
    loadUsers: () => Promise<DdUser[]>;
    policy: () => Promise<Awaited<ReturnType<typeof loadIntakeScreeningPolicy>>>;
  }
): Promise<void> {
  const { read } = deps;
  const all = await listLiveDdtextSignals(principal, { sinceIso: new Date(now.getTime() - DDTEXT_LIVE_DAYS * DAY_MS).toISOString() }, read);
  const taskIds = [...new Set(all.map((s) => s.taskId).filter((id): id is string => id !== null))];
  // C25 / §0.3 "both copies end together": a sender muted later drops their
  // signals of EVERY age, as P3's tombstone covers threads of every age, not
  // only the live 14 days (review security-4). The older tasks are screened
  // in the same call; one of them that can't be screened now is skipped (it
  // backs nothing live, and the next run screens it again), never thrown.
  const liveTaskIds = new Set(taskIds);
  const olderTaskIds = (await listDdtextSignalTaskIds(principal, read)).filter((id) => !liveTaskIds.has(id));
  const screenIds = [...taskIds, ...olderTaskIds];
  const withheld = screenIds.length > 0 ? await restrictedIntakeTaskIds(principal, screenIds, await deps.policy(), read) : new Map<string, IntakeWithholdReason>();
  const doomed: string[] = [];
  for (const [taskId, why] of withheld) {
    if (why === "unscreened") {
      // P2b's rule: never sync a partial picture.
      if (liveTaskIds.has(taskId)) throw new Error(`${DDTEXT_JOB_KIND}: the tasks behind live signals couldn't be screened; not syncing`);
      continue;
    }
    if (PERMANENT_WITHHOLD.has(why)) doomed.push(taskId);
  }
  if (doomed.length > 0) counts.withheldDeleted = await deleteDdtextItemsForTasks(principal, doomed, read);
  const doomedSet = new Set(doomed);
  const remaining: DdtextSignalRow[] = all.filter((s) => s.taskId === null || !doomedSet.has(s.taskId));

  const remainingTaskIds = [...new Set(remaining.map((s) => s.taskId).filter((id): id is string => id !== null))];
  const tasks = remainingTaskIds.length > 0 ? await listTasksByIds(principal, remainingTaskIds, read) : [];
  const users = await deps.loadUsers();
  // His activity on the tasks behind decisions and mentions, from the earliest of those signals on.
  const asks = remaining.filter((s) => s.taskId !== null && (s.kind === "decision" || s.kind === "mention"));
  const principalActivityByTask = new Map<string, number>();
  const earliest = Math.min(...asks.map((s) => ms(s.sourceCreatedAt)).filter(Number.isFinite));
  if (asks.length > 0 && Number.isFinite(earliest)) {
    const filter = { taskIds: [...new Set(asks.map((s) => s.taskId as string))], userId: principal.userId };
    const since = new Date(earliest).toISOString();
    const [activity, messages] = await Promise.all([listActivitySince(principal, since, filter, read), listTaskMessagesSince(principal, since, filter, read)]);
    for (const row of [...activity, ...messages]) {
      const at = ms(row.createdAt);
      if (!Number.isFinite(at)) continue;
      const seen = principalActivityByTask.get(row.taskId);
      if (seen === undefined || at > seen) principalActivityByTask.set(row.taskId, at);
    }
  }
  const eodAsks = [...new Set(remaining.filter((s) => s.sourceType === "eod_note" && s.kind === "decision").map((s) => s.sourceId))];
  const repliesByNote = new Map<string, number>();
  if (eodAsks.length > 0) {
    for (const r of await listUpdateRepliesByUser(principal, principal.userId, eodAsks, read)) {
      const at = ms(r.createdAt);
      if (!Number.isFinite(at)) continue;
      const seen = repliesByNote.get(r.targetId);
      if (seen === undefined || at > seen) repliesByNote.set(r.targetId, at);
    }
  }
  const mentionTasks = [...new Set(remaining.filter((s) => s.kind === "mention" && s.taskId !== null).map((s) => s.taskId as string))];
  const liveP2bMentionTaskIds = new Set<string>();
  if (mentionTasks.length > 0) {
    const statuses = await listAttentionStatusByFingerprints(principal, mentionTasks.map(ddMentionFingerprint), read);
    for (const taskId of mentionTasks) {
      const status = statuses.get(ddMentionFingerprint(taskId));
      if (status !== undefined && status !== "resolved") liveP2bMentionTaskIds.add(taskId);
    }
  }
  const hashes = await listDdtextItemsByKeys(principal, remaining.map((s) => ({ sourceType: s.sourceType, sourceId: s.sourceId })), read);
  const itemHashes = new Map([...hashes].map(([k, v]) => [k, v.contentHash]));
  // Review data-2: an item that vanished between the signals read and the
  // hash read (the daily retention purge, a DD hard delete's cascade, the
  // disable script) neither makes a candidate (its state hash would be over an
  // empty content hash and reopen a seen or owner-resolved row) nor backs one
  // in the orphan purge below.
  const backed = remaining.filter((s) => itemHashes.has(`${s.sourceType}:${s.sourceId}`));

  const input = {
    principal,
    now,
    signals: backed,
    itemHashes,
    tasksById: new Map(tasks.map((t) => [t.id, t])),
    usersById: new Map(users.map((u) => [u.id, u])),
    principalActivityByTask,
    repliesByNote,
    liveP2bMentionTaskIds,
    withheldTaskIds: new Set(withheld.keys())
  };
  // Review data-1: the rows of signals that fail only a status-dependent check
  // keep his seen / dismiss / snooze through the status move (producers HOLDS).
  const held = heldFingerprints(input);
  const ownerStatusByFingerprint = held.length > 0 ? await listAttentionStatusByFingerprints(principal, held, read) : new Map<string, AttentionStatus>();
  const candidates = buildDdtextCandidates({ ...input, ownerStatusByFingerprint });
  const r = await syncAttention(principal, { source: "dd", kinds: DDTEXT_ATTENTION_KINDS }, candidates, now, read);
  counts.inserted = r.inserted;
  counts.updated = r.updated;
  counts.reopened = r.reopened;
  counts.resolved = r.resolved;
  counts.unchanged = r.unchanged;
  counts.orphansDeleted = await purgeOrphanDdtextAttention(now, { principal, backing: backed, signal: read.signal });
}

/** bulk, timeoutMs 240_000 */
export const ddtextJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: DDTEXT_JOB_KIND,
  lane: "bulk",
  timeoutMs: TIMEOUT_MS,
  run: (ctx) => runDdtextTriage(ctx)
});

/** interval 10, bulk, maxAttempts 3, no `enabled` gate (ungated, like P3 L24): off deletes, not installed skips. */
export const ddtextScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: DDTEXT_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: EVERY_MINUTES },
  maxAttempts: MAX_ATTEMPTS
});
