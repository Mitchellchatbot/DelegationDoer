import "server-only";

import {
  deleteAttentionItemsByIds,
  deleteEmailAttentionForThreads,
  listAllEmailAttentionRows,
  parseEmailFingerprint,
  syncAttention
} from "@/lib/exec/attention";
import { listChatDraftIdsForThreads, redactChatForThreads } from "@/lib/exec/chat-store";
import { purgeDraftsByIds, purgeDraftsForThreads } from "@/lib/exec/drafts-store";
import { stampDecision } from "@/lib/exec/email-state";
import {
  applyThreadProposal,
  deleteCommitmentsForThreads,
  deleteSignalsForThreads,
  listCommitments,
  listProducerThreads,
  listRescreenBatch,
  listSignalsForMessages,
  listThreadScreenRows,
  listTombstonedThreadIds,
  setCommitmentStatus,
  stampScreened,
  type RescreenRow
} from "@/lib/exec/email-store";
import type { ExecCommitment } from "@/lib/exec/email-types";
import {
  EMAIL_ATTENTION_JOB_KIND,
  EMAIL_ATTENTION_MAX_ATTEMPTS,
  attentionKick,
  enqueueBulkTriage,
  enqueueJob,
  isAttentionKick,
  retriageKey,
  type BulkTriageItem
} from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import {
  COMMITMENT_OVERDUE_MAX_DAYS,
  EMAIL_ATTENTION_KINDS,
  HEALTH_DROP_WINDOW_DAYS,
  SATISFACTION_WINDOW_DAYS,
  buildEmailCandidates,
  isHealthDrop,
  type HealthDrop
} from "@/lib/exec/producers/email";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { latestScoredInboundByClient, listClients, listSatisfactionSignals } from "@/lib/exec/sources/dd";
import type { ClientHealthLabel, DdClient } from "@/lib/exec/sources/dd-types";
import { isPinnedAccount, listAllReplyArtifacts, loadScreeningPolicy, pinnedAccounts, screenStoredRow, usableAccounts } from "@/lib/exec/sources/mail";
import {
  casSyncState,
  getSyncState,
  parseAccountsState,
  parseHealthState,
  parsePolicyState,
  problemAccountIds,
  putSyncState,
  releaseLease,
  tryAcquireLease,
  type HealthLabelState,
  type HealthState,
  type PolicyState
} from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext, type JobHandler } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// exec.email-attention: the email Needs Attention pass (contract §3.13, L5,
// L24, A6, round-4 addenda §1.1, §1.7, §1.8). No clone and no model calls:
// everything here reads and writes DD's own tables.
//
//   1  Lease. One pass per principal at a time (email/attention-lease, TTL =
//      the timeout + 60 s, released in `finally`). A kicked run that finds it
//      held re-kicks itself for the next minute; a scheduled run skips.
//   2  Not installed (the P3 migration isn't applied): skip.
//   3  Policy step, time-boxed to 45 s. The strict rules and their hash H; a
//      new H starts a new generation. Rows screened under another policy are
//      re-planned with the state machine's stamp rule: stamped in bulk,
//      tombstoned through the tombstone procedure, or (truncated, or a
//      tombstone now clean) sent to a policy re-triage. The producer tier
//      (what the items are built from) goes first, all of it; then the rest,
//      1000 rows from mail/restricted-policy's rescreenAfter, wrapping (and
//      bumping the lap) when a batch comes back short.
//   3b Safety net 1, outside the time box: every tombstoned thread's email
//      items, commitments and signals are hard-deleted, and so are commitment
//      items whose commitment no longer exists.
//   4  Email off, or no pinned mailbox: sync nothing (every email item
//      resolves) and stop.
//   5  Reads: producer rows, open commitments and their thread rows, the CL1
//      signals, DD reply artifacts, clients, satisfaction scores. Any failed
//      read throws before the sync: an empty sync would resolve every item.
//   6  The client-health snapshot (the first run only snapshots), then
//      commitments more than 30 days overdue move to expired.
//   7  Sync the candidates (producers/email.ts) within source "email" and the
//      email kinds.
//   8  Safety net 2, the same deletes, outside the time box: a thread that
//      became a tombstone between the reads and the sync leaves no item, and
//      neither does a producer row the screen found matching a rule.
//
// Failing to read the rules ends the pass before anything is synced: nothing
// could be screened. Anything else that fails in step 3 (a bulk stamp, a
// tombstone, a re-triage enqueue, the cursor's row) doesn't stop it: the
// producer screens every row with the rules just loaded and the nets still
// run, so the sync stays safe. The first such error is thrown at the end,
// after the sync, so the job retries and a programming error dead-letters to
// ops. A row whose tombstone failed transiently keeps the rest cursor in
// front of it; an abort (the job's timeout) ends the pass at once.
//
// The job's result holds counts and codes only (boundary rule 9).

export { EMAIL_ATTENTION_JOB_KIND };

/** §3.11: the attention pass's ceiling. */
export const EMAIL_ATTENTION_TIMEOUT_MS = 120_000;
/** L5: TTL = timeoutMs + 60 s, so a crashed holder's lease frees itself soon after its run could have ended. */
export const ATTENTION_LEASE_TTL_MS = EMAIL_ATTENTION_TIMEOUT_MS + 60_000;
/** §3.13: the policy step's time box. The safety nets and the sync run outside it. */
export const POLICY_TIME_BOX_MS = 45_000;
/** Rows per re-screen batch (the rest tier's lap step; listRescreenBatch's ceiling). */
export const RESCREEN_BATCH = 1_000;
const ATTENTION_EVERY_MINUTES = 10;
const MAX_PRODUCER_PAGES = 50;
const LEASE_KEY = "attention-lease";
const MAX_HOLDER_CHARS = 200;
const DAY_MS = 86_400_000;
const POLICY_STATE_ATTEMPTS = 3;
const HEALTH_STATE_ATTEMPTS = 3;

const COMMITMENT_STATUSES = ["open", "followed_up", "expired"] as const;

// ---------------------------------------------------------------------------
// The job's result (counts and codes only)
// ---------------------------------------------------------------------------

export interface PolicyStepCounts {
  generation: number;
  lap: number;
  stamped: number;
  tombstoned: number;
  retriageEnqueued: number;
  retriageDuplicates: number;
  retriageBlocked: number;
  /** Rows that needed a re-triage the pass may not send (email off, a problem account). */
  retriageSkipped: number;
  failures: number;
  timedOut: boolean;
  wrapped: boolean;
}

export interface SafetyNetCounts {
  threads: number;
  attentionRows: number;
  commitments: number;
  /** P4 (X5): assistant drafts emptied for those threads; null = the P4 migration isn't applied. */
  drafts: number | null;
  signals: number;
  orphanItems: number;
  /** P5b (contract §3.18, C19): chat answers redacted for those threads (0 before the P5b migration). */
  chatRedacted: number;
  /** P5b (C20): chat drafts on those answers' cards purged by id; null = P4's purge-by-id RPC isn't there. */
  chatDrafts: number | null;
}

export interface EmailAttentionSummary {
  skipped?: "lease_held" | "not_installed";
  /** A kick that found the lease held and queued itself for the next minute. */
  requeued?: boolean;
  /** Email is off or no mailbox is pinned: everything resolved. */
  off?: true;
  policy?: PolicyStepCounts;
  net1?: SafetyNetCounts;
  net2?: SafetyNetCounts;
  candidates?: number;
  sync?: { inserted: number; updated: number; reopened: number; resolved: number; unchanged: number };
  healthDrops?: number;
  expired?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const unique = (ids: readonly (string | null | undefined)[]): string[] => [
  ...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))
];

function leaseHolder(ctx: JobContext): string {
  const holder = `${ctx.workerId}#${ctx.job.id}.${ctx.job.attempts}`;
  return holder.length <= MAX_HOLDER_CHARS ? holder : holder.slice(holder.length - MAX_HOLDER_CHARS);
}

/** Email work may run (L1): the column is on and a mailbox is pinned. */
const emailOn = (principal: ExecPrincipal, settings: ExecSettings) => settings.emailEnabled && pinnedAccounts(principal).length > 0;

// ---------------------------------------------------------------------------
// Step 3: the policy step
// ---------------------------------------------------------------------------

interface PolicyRead {
  state: PolicyState;
  rev: number;
}

/**
 * mail/restricted-policy for hash H: the stored state when it already has H,
 * else a new generation (rescreenAfter and the lap start over). A stored row
 * that doesn't parse is replaced, never left to wedge the pass.
 */
async function policyStateFor(principal: ExecPrincipal, hash: string, now: Date, signal: AbortSignal): Promise<PolicyRead> {
  for (let attempt = 1; attempt <= POLICY_STATE_ATTEMPTS; attempt += 1) {
    const current = await getSyncState(principal, "mail", "restricted-policy", parsePolicyState, { signal });
    if (current && current.value.hash === hash) return { state: current.value, rev: current.rev };
    const next: PolicyState = {
      hash,
      generation: current ? current.value.generation + 1 : 1,
      appliedAt: now.toISOString(),
      rescreenAfter: null,
      lap: 0
    };
    if (await casSyncState(principal, "mail", "restricted-policy", current?.rev ?? null, next, { signal })) {
      return { state: next, rev: (current?.rev ?? 0) + 1 };
    }
    if (current === null && attempt > 1) {
      // The row is there (the insert lost) but doesn't parse: start it over.
      await putSyncState(principal, "mail", "restricted-policy", next, { signal });
      const reread = await getSyncState(principal, "mail", "restricted-policy", parsePolicyState, { signal });
      if (reread && reread.value.hash === hash) return { state: reread.value, rev: reread.rev };
    }
  }
  throw new Error(`exec email attention: mail/restricted-policy kept changing for ${principal.id}`);
}

interface PolicyStepCtx {
  principal: ExecPrincipal;
  settings: ExecSettings;
  now: Date;
  signal: AbortSignal;
  rules: readonly RestrictedSenderRule[];
  hash: string;
  policy: PolicyRead;
  /** Re-triages may be enqueued: email is on. */
  retriage: boolean;
  usable: ReadonlySet<string>;
  /** Date.now() past which no new work starts. */
  deadline: number;
  /** Thread ids already sent to a re-triage in this pass (both tiers list the same rows). */
  sent: Set<string>;
  /** Thread ids that needed a re-triage this pass may not send. */
  unsent: Set<string>;
  /** Thread ids whose tombstone failed in this pass (not tried again until the next). */
  failed: Set<string>;
  counts: PolicyStepCounts;
  errors: unknown[];
}

const timeLeft = (p: PolicyStepCtx) => Date.now() < p.deadline;

/**
 * Record a failure of part of the policy step and carry on: the safety nets
 * and the sync still run (the producer screens every row with the rules this
 * pass loaded, so the sync is safe without the stamps), and the pass throws
 * the first error at the end. An abort (the job's timeout, a lost lease) ends
 * the pass at once.
 */
function failed(p: Pick<PolicyStepCtx, "signal" | "counts" | "errors">, err: unknown): void {
  p.signal.throwIfAborted();
  p.counts.failures += 1;
  p.errors.push(err);
}

/**
 * Plan and apply one batch of rows screened under another policy. Returns how
 * many rows, from the front of the batch, are finished: the rest cursor never
 * moves past a row whose tombstone didn't land or whose re-triage wasn't
 * queued (the time box, the bulk cap or a failure), so the next pass meets it
 * again.
 */
async function rescreenRows(p: PolicyStepCtx, rows: readonly RescreenRow[]): Promise<number> {
  const { principal } = p;
  const decisions = rows.map((row) => stampDecision(row, { rules: p.rules, currentPolicyHash: p.hash }));
  let unfinished = rows.length;
  const stop = (i: number) => {
    unfinished = Math.min(unfinished, i);
  };

  // Bulk stamp: one RPC per 200 rows, compare-and-set on each row's version.
  const stampAt = rows.map((_, i) => i).filter((i) => decisions[i] === "stamp");
  if (stampAt.length > 0) {
    if (!timeLeft(p)) {
      p.counts.timedOut = true;
      return 0;
    }
    try {
      p.counts.stamped += await stampScreened(
        principal,
        stampAt.map((i) => ({ threadId: rows[i].threadId, version: rows[i].version })),
        p.hash,
        { signal: p.signal }
      );
    } catch (err) {
      failed(p, err);
      stop(stampAt[0]);
    }
  }

  // Tombstones go through the store's procedure (commitments, the whitelist
  // row, signals, attention rows), one thread at a time.
  const retriage: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (decisions[i] === "needs_fresh_read" || decisions[i] === "needs_retriage") retriage.push(i);
    if (decisions[i] !== "tombstone") continue;
    if (p.failed.has(rows[i].threadId)) {
      stop(i);
      continue;
    }
    if (!timeLeft(p)) {
      p.counts.timedOut = true;
      stop(i);
      break;
    }
    try {
      const r = await applyThreadProposal(
        principal,
        p.settings,
        rows[i].threadId,
        { kind: "stamp", policyHash: p.hash },
        { now: p.now, retentionDays: p.settings.retentionDaysEmail },
        { signal: p.signal }
      );
      if (r.result === "tombstoned") p.counts.tombstoned += 1;
      // The row moved on since it was listed; the store re-planned it. Two of
      // its answers still ask for a re-triage.
      else if (r.result === "skipped" && (r.reason === "needs_fresh_read" || r.reason === "needs_retriage")) retriage.push(i);
    } catch (err) {
      failed(p, err);
      p.failed.add(rows[i].threadId);
      // A transient failure keeps the rest cursor here, so the next pass
      // tries this row again. A programming error (a store refusal) would
      // fail the same way forever: the cursor moves on, and the job still
      // dead-letters to ops at the end of the pass.
      if (!(err instanceof NonRetryableError)) stop(i);
      console.error(`[exec-email-attention] tombstone of thread ${rows[i].threadId} failed for ${principal.id}; the job reports it after the sync`);
    }
  }

  // Re-triages: a fresh read is the only way to settle a truncated row or to
  // leave a clean tombstone. Never while email is off, never for a problem
  // account (addenda §1.7), never twice for one thread in one pass.
  const items: BulkTriageItem[] = [];
  const itemRow: number[] = [];
  const disc = `g${p.policy.state.generation}.l${p.policy.state.lap}`;
  for (const i of [...new Set(retriage)].sort((a, b) => a - b)) {
    const row = rows[i];
    if (!p.retriage || !p.usable.has(row.accountId)) {
      p.unsent.add(row.threadId);
      p.counts.retriageSkipped = p.unsent.size;
      continue;
    }
    if (p.sent.has(row.threadId)) continue;
    items.push({ threadId: row.threadId, accountId: row.accountId, reason: "policy", dedupeKey: retriageKey(principal.id, row.threadId, "policy", disc) });
    itemRow.push(i);
  }
  if (items.length > 0) {
    if (!timeLeft(p)) {
      p.counts.timedOut = true;
      stop(itemRow[0]);
    } else {
      try {
        const r = await enqueueBulkTriage(principal, items, p.now, { signal: p.signal });
        p.counts.retriageEnqueued += r.enqueued;
        p.counts.retriageDuplicates += r.duplicates;
        p.counts.retriageBlocked += r.blocked;
        const blocked = new Set(r.blockedKeys);
        items.forEach((item, k) => {
          if (blocked.has(item.dedupeKey)) stop(itemRow[k]);
          else p.sent.add(item.threadId);
        });
      } catch (err) {
        failed(p, err);
        stop(itemRow[0]);
      }
    }
  }
  return unfinished;
}

/**
 * The producer tier, all of it: these rows become items, so they are settled
 * before anything else. No cursor: a row left unstamped is simply listed again
 * by the next pass. Returns false when the time box ran out.
 */
async function producerTier(p: PolicyStepCtx): Promise<boolean> {
  let after: string | null = null;
  for (let page = 0; page < MAX_PRODUCER_PAGES; page += 1) {
    if (!timeLeft(p)) return false;
    const rows = await listRescreenBatch(p.principal, p.hash, { tier: "producer", afterThreadId: after, limit: RESCREEN_BATCH, now: p.now }, { signal: p.signal });
    await rescreenRows(p, rows);
    if (rows.length < RESCREEN_BATCH) break;
    after = rows[rows.length - 1].threadId;
  }
  return timeLeft(p);
}

async function policyStep(p: PolicyStepCtx): Promise<void> {
  let more = false;
  try {
    more = await producerTier(p);
  } catch (err) {
    failed(p, err);
    more = timeLeft(p);
  }
  if (!more) {
    p.counts.timedOut = true;
    return;
  }
  try {
    await restTier(p);
  } catch (err) {
    failed(p, err);
  }
}

/**
 * The rest: every state and age, one batch per pass, from where the last pass
 * stopped. A short batch ends the lap (A7): the next lap starts over, and its
 * re-triage keys (g<generation>.l<lap>) are new, so a row whose last
 * re-triage ended without a write gets another (amendments-2(a)).
 */
async function restTier(p: PolicyStepCtx): Promise<void> {
  const { principal } = p;
  const { state } = p.policy;
  const rows = await listRescreenBatch(
    principal,
    p.hash,
    { tier: "rest", afterThreadId: state.rescreenAfter, limit: RESCREEN_BATCH, now: p.now },
    { signal: p.signal }
  );
  const finished = await rescreenRows(p, rows);
  let next: Pick<PolicyState, "rescreenAfter" | "lap">;
  if (finished === rows.length && rows.length < RESCREEN_BATCH) {
    const lapRan = state.rescreenAfter !== null || rows.length > 0;
    next = { rescreenAfter: null, lap: lapRan ? state.lap + 1 : state.lap };
    p.counts.wrapped = lapRan;
  } else {
    next = { rescreenAfter: finished > 0 ? rows[finished - 1].threadId : state.rescreenAfter, lap: state.lap };
  }
  if (next.rescreenAfter === state.rescreenAfter && next.lap === state.lap) return;
  const saved = await casSyncState(principal, "mail", "restricted-policy", p.policy.rev, { ...state, ...next }, { signal: p.signal });
  // Lost only to another pass's write (the lease makes that rare); that pass
  // moved the position itself, and re-planning rows is harmless.
  if (!saved) console.warn(`[exec-email-attention] rescreen position not saved for ${principal.id}: mail/restricted-policy moved`);
}

// ---------------------------------------------------------------------------
// Steps 3b and 8: the safety nets
// ---------------------------------------------------------------------------

/** Commitment items whose commitment row is gone (a tombstone, the purge): their text must not outlive it. */
async function deleteOrphanCommitmentItems(principal: ExecPrincipal, signal: AbortSignal): Promise<number> {
  const items = (await listAllEmailAttentionRows(principal, { signal }))
    .map((row) => ({ row, parsed: parseEmailFingerprint(row.fingerprint) }))
    .filter((x) => x.parsed?.kind === "commitment" && x.parsed.threadId !== null);
  if (items.length === 0) return 0;
  const threadIds = unique(items.map((x) => x.parsed?.threadId));
  const existing = new Set(
    (await listCommitments(principal, { statuses: [...COMMITMENT_STATUSES], threadIds }, { signal })).map((c) => c.id)
  );
  const orphans = items.filter((x) => !existing.has(x.parsed?.key ?? "")).map((x) => x.row.id);
  if (orphans.length === 0) return 0;
  return deleteAttentionItemsByIds(principal, orphans, { source: "email", signal });
}

/**
 * Hard-delete what must not survive a restricted thread (A6): its email items
 * in every status, its commitments, its assistant drafts' content (P4 X5: the
 * restricted purge, after the commitments delete, over the same threads), its
 * chat answers (P5b, §3.18: redacted, and the chat drafts on their cards
 * purged by id; both verdicts here are verified, a tombstone or a rule match,
 * so the redaction is principal-wide, C21) and its signal rows, for every
 * tombstoned thread plus `alsoRestricted` (rows the screen found matching a
 * rule that aren't tombstones yet); then orphaned commitment items.
 */
async function safetyNet(principal: ExecPrincipal, alsoRestricted: readonly string[], signal: AbortSignal): Promise<SafetyNetCounts & { tombstoned: string[] }> {
  const tombstoned = await listTombstonedThreadIds(principal, { signal });
  const threads = unique([...tombstoned, ...alsoRestricted]);
  const counts: SafetyNetCounts = {
    threads: threads.length, attentionRows: 0, commitments: 0, drafts: null, signals: 0, orphanItems: 0, chatRedacted: 0, chatDrafts: 0
  };
  if (threads.length > 0) {
    counts.attentionRows = await deleteEmailAttentionForThreads(principal, threads, { signal });
    counts.commitments = await deleteCommitmentsForThreads(principal, threads, { signal });
    counts.drafts = await purgeDraftsForThreads(principal, threads, { signal });
    counts.chatRedacted = await redactChatForThreads(principal, threads, { signal });
    const chatDraftIds = await listChatDraftIdsForThreads(principal, threads, { signal });
    counts.chatDrafts = chatDraftIds.length > 0 ? await purgeDraftsByIds(principal, chatDraftIds, { signal }) : 0;
    counts.signals = await deleteSignalsForThreads(principal, threads, { signal });
  }
  counts.orphanItems = await deleteOrphanCommitmentItems(principal, signal);
  return { ...counts, tombstoned };
}

const netCounts = (n: SafetyNetCounts): SafetyNetCounts => ({
  threads: n.threads,
  attentionRows: n.attentionRows,
  commitments: n.commitments,
  drafts: n.drafts,
  signals: n.signals,
  orphanItems: n.orphanItems,
  chatRedacted: n.chatRedacted,
  chatDrafts: n.chatDrafts
});

// ---------------------------------------------------------------------------
// Step 6: the client-health snapshot (L13) and commitment expiry
// ---------------------------------------------------------------------------

const HEALTH_RANK: Readonly<Record<ClientHealthLabel, number>> = Object.freeze({ thriving: 3, steady: 2, shaky: 1, at_risk: 0 });
const isLabel = (v: unknown): v is ClientHealthLabel => typeof v === "string" && Object.hasOwn(HEALTH_RANK, v);

function activeClient(c: Pick<DdClient, "status">): boolean {
  // listClients maps a NULL status to "active", as DD's own pages read it.
  return c.status === "active" || c.status === "";
}

/**
 * The next snapshot of effective health labels (override ?? computed) and the
 * drops it records. With no snapshot yet, it only records the labels (L13:
 * the first run makes no items). A drop is a move to a worse band; it is kept
 * (with the band it fell from and when) while the label stays below that
 * band, and cleared when the client recovers. A further drop inside the item
 * window keeps the band the slide started from.
 */
export function advanceHealthSnapshot(
  previous: HealthState | null,
  clients: readonly Pick<DdClient, "id" | "status" | "healthLabel" | "healthOverrideLabel">[],
  now: Date
): { next: HealthState; drops: HealthDrop[] } {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const windowMs = HEALTH_DROP_WINDOW_DAYS * DAY_MS;
  const labels = Object.create(null) as Record<string, HealthLabelState>;
  const drops: HealthDrop[] = [];
  const sorted = [...clients].filter((c) => typeof c?.id === "string" && c.id.length > 0).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of sorted) {
    const label = c.healthOverrideLabel ?? c.healthLabel;
    if (!activeClient(c) || !isLabel(label)) continue;
    const old = previous ? previous.labels[c.id] : undefined;
    const oldLabel = old && isLabel(old.label) ? old.label : null;
    const oldFrom = old && isLabel(old.droppedFrom) ? old.droppedFrom : null;
    const oldAt = old?.droppedAt ?? null;
    const oldAtMs = oldAt ? Date.parse(oldAt) : Number.NaN;
    const slideOn = oldFrom !== null && Number.isFinite(oldAtMs) && nowMs - oldAtMs <= windowMs;
    let entry: HealthLabelState;
    if (previous === null || oldLabel === null) {
      entry = { label, droppedFrom: null, droppedAt: null };
    } else if (HEALTH_RANK[label] < HEALTH_RANK[oldLabel]) {
      entry = { label, droppedFrom: slideOn && oldFrom !== null ? oldFrom : oldLabel, droppedAt: nowIso };
    } else if (oldFrom !== null && oldAt !== null && HEALTH_RANK[label] < HEALTH_RANK[oldFrom]) {
      entry = { label, droppedFrom: oldFrom, droppedAt: oldAt };
    } else {
      entry = { label, droppedFrom: null, droppedAt: null };
    }
    labels[c.id] = entry;
    if (previous === null || entry.droppedFrom === null || entry.droppedAt === null || !isLabel(entry.droppedFrom)) continue;
    const at = Date.parse(entry.droppedAt);
    if (!Number.isFinite(at) || nowMs - at > windowMs || !isHealthDrop(entry.droppedFrom, label)) continue;
    drops.push({ clientId: c.id, from: entry.droppedFrom, to: label, droppedAt: entry.droppedAt, overridden: c.healthOverrideLabel !== null });
  }
  return { next: { takenAt: nowIso, labels }, drops };
}

function sameLabels(a: HealthState["labels"], b: HealthState["labels"]): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k].label === b[k].label && a[k].droppedFrom === b[k].droppedFrom && a[k].droppedAt === b[k].droppedAt);
}

/** Advance email/client-health and return the live drops. Written only when a label moved. */
async function healthDrops(principal: ExecPrincipal, clients: readonly DdClient[], now: Date, signal: AbortSignal): Promise<HealthDrop[]> {
  for (let attempt = 1; attempt <= HEALTH_STATE_ATTEMPTS; attempt += 1) {
    const current = await getSyncState(principal, "email", "client-health", parseHealthState, { signal });
    const { next, drops } = advanceHealthSnapshot(current?.value ?? null, clients, now);
    if (current && sameLabels(current.value.labels, next.labels)) return drops;
    if (await casSyncState(principal, "email", "client-health", current?.rev ?? null, next, { signal })) return drops;
    if (current === null && attempt > 1) {
      // There is a row and it doesn't parse: start the snapshot over (no items from it).
      await putSyncState(principal, "email", "client-health", next, { signal });
      return [];
    }
  }
  throw new Error(`exec email attention: email/client-health kept changing for ${principal.id}`);
}

/** Move open commitments more than COMMITMENT_OVERDUE_MAX_DAYS overdue to expired; returns the rest. */
async function expireCommitments(
  principal: ExecPrincipal,
  commitments: readonly ExecCommitment[],
  now: Date,
  signal: AbortSignal
): Promise<{ live: ExecCommitment[]; expired: number }> {
  const cutoff = now.getTime() - COMMITMENT_OVERDUE_MAX_DAYS * DAY_MS;
  const live: ExecCommitment[] = [];
  let expired = 0;
  for (const c of commitments) {
    const due = c.dueAt ? Date.parse(c.dueAt) : Number.NaN;
    if (c.status === "open" && Number.isFinite(due) && due < cutoff) {
      // Compare-and-set on "open": a follow-up recorded meanwhile wins.
      await setCommitmentStatus(principal, c.id, "expired", null, { expectStatus: "open", now, signal });
      expired += 1;
      continue;
    }
    live.push(c);
  }
  return { live, expired };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

async function runPass(ctx: JobContext, principal: ExecPrincipal, now: Date, out: EmailAttentionSummary): Promise<void> {
  const { signal } = ctx;
  // 2. Not installed: nothing email exists to screen or show.
  const settings = await loadSettings(principal.id);
  if (!settings.emailSchemaReady) {
    out.skipped = "not_installed";
    return;
  }
  const on = emailOn(principal, settings);
  const errors: unknown[] = [];

  // 3. The policy step (time-boxed). Without the rules nothing can be
  // screened, so their failure ends the pass before any sync; anything else
  // that fails in this step is recorded and the pass goes on (see failed()).
  const startedAt = Date.now();
  const { rules, hash } = await loadScreeningPolicy(principal, { signal });
  const counts: PolicyStepCounts = {
    generation: 0,
    lap: 0,
    stamped: 0,
    tombstoned: 0,
    retriageEnqueued: 0,
    retriageDuplicates: 0,
    retriageBlocked: 0,
    retriageSkipped: 0,
    failures: 0,
    timedOut: false,
    wrapped: false
  };
  out.policy = counts;
  try {
    const policy = await policyStateFor(principal, hash, now, signal);
    counts.generation = policy.state.generation;
    counts.lap = policy.state.lap;
    let usable: ReadonlySet<string> = new Set<string>();
    if (on) {
      const accounts = await getSyncState(principal, "mail", "accounts", parseAccountsState, { signal });
      usable = new Set(usableAccounts(principal, problemAccountIds(accounts?.value ?? null)));
    }
    await policyStep({
      principal,
      settings,
      now,
      signal,
      rules,
      hash,
      policy,
      retriage: on,
      usable,
      deadline: startedAt + POLICY_TIME_BOX_MS,
      sent: new Set(),
      unsent: new Set(),
      failed: new Set(),
      counts,
      errors
    });
  } catch (err) {
    failed({ signal, counts, errors }, err);
  }

  // 3b. Safety net 1 (untimed).
  const net1 = await safetyNet(principal, [], signal);
  out.net1 = netCounts(net1);

  // 4. Email off or nothing pinned: no email item stands (L24).
  if (!on) {
    const r = await syncAttention(principal, { source: "email", kinds: EMAIL_ATTENTION_KINDS }, [], now, { signal });
    out.off = true;
    out.sync = { inserted: r.inserted, updated: r.updated, reopened: r.reopened, resolved: r.resolved, unchanged: r.unchanged };
    if (errors.length > 0) throw errors[0];
    return;
  }

  // 5. Reads. Any failure throws here, before the sync.
  const [threads, openCommitments, artifacts, clients, latestScored] = await Promise.all([
    listProducerThreads(principal, now, { signal }),
    listCommitments(principal, { statuses: ["open"] }, { signal }),
    listAllReplyArtifacts(principal, { signal }),
    listClients(principal, { signal }),
    latestScoredInboundByClient(principal, { signal, now })
  ]);
  const satisfactionRows = await listSatisfactionSignals(
    principal,
    new Date(now.getTime() - SATISFACTION_WINDOW_DAYS * DAY_MS).toISOString(),
    { rules, tombstonedThreadIds: net1.tombstoned },
    { signal }
  );
  const screenRows = await listThreadScreenRows(principal, unique(openCommitments.map((c) => c.threadId)), { signal });
  const signals = await listSignalsForMessages(
    principal,
    unique(threads.flatMap((t) => [t.newestInboundMessageId, t.newestMessageId])),
    { signal }
  );

  // 6. Health, then expiry.
  const drops = await healthDrops(principal, clients, now, signal);
  out.healthDrops = drops.length;
  const { live, expired } = await expireCommitments(principal, openCommitments, now, signal);
  out.expired = expired;

  // 7. Sync. Items come only from the mailboxes pinned to him now (ui-3): a
  // row of an account he no longer has pinned (re-pinned after a reconnect)
  // would raise an item whose thread page 404s. Its items resolve here; the
  // screens below (step 8) still see every row.
  const candidates = buildEmailCandidates({
    timezone: principal.timezone,
    threads: threads.filter((t) => isPinnedAccount(principal, t.accountId)),
    commitments: live,
    screenRows: new Map([...screenRows].filter(([, r]) => isPinnedAccount(principal, r.accountId))),
    signals,
    artifacts,
    satisfaction: { rows: satisfactionRows, latestScoredByClient: latestScored },
    healthDrops: drops,
    clients,
    rules,
    currentPolicyHash: hash,
    now
  });
  out.candidates = candidates.length;
  const r = await syncAttention(principal, { source: "email", kinds: EMAIL_ATTENTION_KINDS }, candidates, now, { signal });
  out.sync = { inserted: r.inserted, updated: r.updated, reopened: r.reopened, resolved: r.resolved, unchanged: r.unchanged };

  // 8. Safety net 2 (untimed), with every row the screen found matching a
  // rule: those are restricted for certain and must lose their items now,
  // even when the time box kept step 3 from tombstoning them yet.
  const ruleMatched = [
    ...threads.filter((t) => screenStoredRow(t, rules, hash).reason === "rule_match").map((t) => t.threadId),
    ...[...screenRows.values()].filter((t) => screenStoredRow(t, rules, hash).reason === "rule_match").map((t) => t.threadId)
  ];
  out.net2 = netCounts(await safetyNet(principal, ruleMatched, signal));

  if (errors.length > 0) throw errors[0];
}

async function run(ctx: JobContext): Promise<EmailAttentionSummary> {
  const { principal } = ctx;
  // Scheduled and kicked runs always carry a principal; a job without one is a bug.
  if (!principal) throw new NonRetryableError(`${EMAIL_ATTENTION_JOB_KIND}: the job has no principal`);
  const now = new Date();
  const holder = leaseHolder(ctx);

  // 1. The lease.
  if (!(await tryAcquireLease(principal, LEASE_KEY, holder, ATTENTION_LEASE_TTL_MS, now))) {
    if (!isAttentionKick(ctx.job)) return { skipped: "lease_held" };
    // A kick's write must still be seen: run again a minute from now.
    const r = await enqueueJob(attentionKick(principal, ctx.job.lane, new Date()));
    return { skipped: "lease_held", requeued: r.enqueued };
  }
  const out: EmailAttentionSummary = {};
  try {
    await runPass(ctx, principal, now, out);
  } finally {
    await releaseLease(principal, LEASE_KEY, holder);
  }
  console.log(
    `[exec-email-attention] ${principal.id}: ${out.skipped ?? (out.off ? "off" : "synced")} candidates=${out.candidates ?? 0} ` +
      `stamped=${out.policy?.stamped ?? 0} tombstoned=${out.policy?.tombstoned ?? 0} retriage=${out.policy?.retriageEnqueued ?? 0}`
  );
  return out;
}

export const emailAttentionJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: EMAIL_ATTENTION_JOB_KIND,
  lane: "bulk",
  timeoutMs: EMAIL_ATTENTION_TIMEOUT_MS,
  run
});

/** L5 / L24: every 10 minutes on the bulk lane, for every enabled principal, ungated (off resolves; not installed skips). */
export const emailAttentionScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: EMAIL_ATTENTION_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: ATTENTION_EVERY_MINUTES },
  maxAttempts: EMAIL_ATTENTION_MAX_ATTEMPTS
});
