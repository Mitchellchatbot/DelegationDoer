import "server-only";

import { auditFinish, auditStart } from "@/lib/exec/audit";
import { CloneEaError, type CloneDraftRead } from "@/lib/exec/clone-ea-types";
import {
  applyDraftPatch,
  auditCode,
  checkedPatch,
  closePurgedCreate,
  giveUpSaving,
  hasLink,
  linkReplacement,
  mapGetResult,
  mapReplayResult,
  mirrorRegistry,
  nextCheckAt,
  priorStatusOf,
  resolveRecreateByGet,
  terminalPatch,
  type CloneAnswer,
  type DraftPatch,
  type Transition,
  type TransitionOptions
} from "@/lib/exec/drafts-state";
import { casDraft, claimDueDraft, earliestDueWithin, getDraft, hasDueDrafts, isUniqueViolation, listDueDrafts, purgeDraftsForThreads, type CasExpect } from "@/lib/exec/drafts-store";
import { DRAFT_JOB_KINDS, DRAFT_LIMITS, type CloneFlag, type ExecDraftRow } from "@/lib/exec/drafts-types";
import { getEmailThread } from "@/lib/exec/email-store";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { checkRecipients, type RecipientContext } from "@/lib/exec/recipients";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import {
  createNewDraft,
  createReplyDraft,
  getOutlookDraft,
  getEaReadiness,
  loadScreeningPolicy,
  pinnedAccounts,
  recreateOutlookDraft,
  screenStoredRow,
  usableAccounts,
  type EaReadiness
} from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, problemAccountIds } from "@/lib/exec/sync-state";
import { AuditUnavailableError, NonRetryableError, type EnqueueJobInput, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// exec.draft-reconcile (P4 contract §3.11, C14, C16-C18, C41, C67-C69; Area D):
// the sweep over due exec_drafts rows. Bulk lane on the schedule (interval 5,
// enabled while the drafts schema is installed, `when` = a row is due), 240 s
// with no new row started after 170 s, 2 attempts; kicks run interactive with
// 1 attempt, 25 s after a send or an "open in Outlook".
//
// Per run: at most 20 rows, stale `saving` rows first (the one replay a run
// may make starts inside its first 60 s); every row is CLAIMED (a counted CAS
// on next_check_at, C67 (1)) before any clone call, so two overlapping runs
// never replay one create twice. Dispatch by status: generating → stale
// (T09); saving → a same-key replay audited first (C67), or the GET
// resolution for a purged recreate, or T51 for a purged create; every other
// linked row → one GET mirrored through §2.6.0 (T32-T35, T40, the C69
// follow-ups, the C41 idle check). Every write bumps check_count and
// recomputes next_check_at. It never imports send.ts (B3) and never calls
// /send. A send's audit row left open by a crashed request is finished here
// once the outcome is known (T31/T32). Nothing here logs content: ids, codes
// and counts only.
//
// The GET-once helpers (cloneGet, casTransition, checkDraftOnce) are exported
// additively: drafts.ts runs the same per-status handler for Check again
// (T49, C70), in the request, without a claim.

export const DRAFT_RECONCILE_TIMEOUT_MS = 240_000;

const KIND = DRAFT_JOB_KINDS.reconcile;
const DUE_LIMIT = 20;
const KICK_WINDOW_MS = 300_000;
const MIN_MS = 60_000;
const KICK_TAG_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
/** One GET of an Outlook draft may take this long (sources/mail.ts's read timeout). */
const GET_MS = 60_000;
/** C4 / C72 (data-5): every clone call of a run ends inside this, 10 s before the job timeout, for the outcome write. */
const RUN_BUDGET_MS = DRAFT_RECONCILE_TIMEOUT_MS - 10_000;

export interface ReconcileCounts { checked: number; transitions: number; skipped: number; kicked: boolean }

const errorName = (err: unknown): string => (err instanceof Error && err.name !== "" ? err.name : "error");
const iso = (ms: number) => new Date(ms).toISOString();

/** The CAS key family of a row's current status (C5): G for generating, Ks / Kd / Kx for the in-flight attempts, V otherwise. */
export function casExpectFor(row: ExecDraftRow): CasExpect {
  switch (row.status) {
    case "generating":
      return { status: "generating", version: row.version, generationSeq: row.generationSeq };
    case "saving":
      return row.saveAttemptKey !== null ? { status: "saving", saveAttemptKey: row.saveAttemptKey } : { status: "saving", version: row.version };
    case "discarding":
      return row.discardAttemptKey !== null ? { status: "discarding", discardAttemptKey: row.discardAttemptKey } : { status: "discarding", version: row.version };
    case "sending":
      return row.sendAttemptKey !== null ? { status: ["sending", "unknown"], sendAttemptKey: row.sendAttemptKey } : { status: "sending", version: row.version };
    default:
      return { status: row.status, version: row.version };
  }
}

/** The ops alert of a transition, rate-limited by its code; ids and codes only. */
export function alertTransition(t: Transition, draftId: string, where: string): void {
  if (t.alert === null) return;
  void notifyOps({ key: `${t.alert}:${where}`, title: `exec drafts: ${t.alert} on ${where} (${t.code ?? "no code"}) for ${draftId}` });
}

/**
 * One GET of the row's Outlook draft (or of `graphId`, e.g. a replacement),
 * as a CloneAnswer: a clone answer or error body, else no answer (transport,
 * timeout, readiness down, a refusal before any I/O).
 */
export async function cloneGet(principal: ExecPrincipal, row: Pick<ExecDraftRow, "accountId" | "outlookGraphId">, graphId?: string): Promise<CloneAnswer<CloneDraftRead>> {
  const id = graphId ?? row.outlookGraphId;
  if (id === null) return { ok: false, noAnswer: true };
  try {
    const value = await getOutlookDraft(principal, { accountId: row.accountId, graphId: id });
    return { ok: true, value, replay: false };
  } catch (err) {
    if (err instanceof CloneEaError) return { ok: false, error: err };
    console.warn(`[exec-drafts] GET of an Outlook draft failed before an answer (${errorName(err)})`);
    return { ok: false, noAnswer: true };
  }
}

export type CasOutcome = "applied" | "missed" | "reappeared";

/**
 * Apply a transition's patch under the row's CAS key family. `lastCheck`
 * (the sweep and Check again) adds the bookkeeping: check_count + 1 and
 * next_check_at recomputed. A 23505 on the one-active index (§2.6.0's gone →
 * saved while another draft holds the thread) leaves the row as it is with
 * last_error_code = outlook_reappeared.
 */
export async function casTransition(principal: ExecPrincipal, row: ExecDraftRow, t: Transition, now: Date, lastCheck: "ok" | "failed" | null): Promise<CasOutcome> {
  const patch: DraftPatch = lastCheck === null ? t.patch : checkedPatch(row, t, now, lastCheck);
  try {
    return (await casDraft(principal, row.id, casExpectFor(row), patch)) ? "applied" : "missed";
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const kept: Transition = { to: row.status, patch: { updated_at: now.toISOString() }, code: "outlook_reappeared", alert: null, reviewCleared: false };
    const retry: DraftPatch = {
      ...(lastCheck === null ? kept.patch : checkedPatch(row, kept, now, lastCheck)),
      last_error_code: "outlook_reappeared",
      last_error_at: now.toISOString()
    };
    await casDraft(principal, row.id, casExpectFor(row), retry);
    return "reappeared";
  }
}

export interface CheckResult { transition: Transition; read: CloneDraftRead | null; applied: CasOutcome }

/** C16: sent_pending for 24 h without verification closes as sent + unverified + verify_overdue, no GET. */
function closeOverdue(row: ExecDraftRow, now: Date, opts: TransitionOptions): Transition {
  const flags: CloneFlag[] = row.cloneFlags.includes("verify_overdue") ? [...row.cloneFlags] : [...row.cloneFlags, "verify_overdue"];
  const patch: DraftPatch = {
    ...terminalPatch(row, "sent", now, opts),
    sent_at: row.sentAt ?? row.sendAcceptedAt ?? now.toISOString(),
    unverified: true,
    clone_flags: flags
  };
  return { to: "sent", patch, code: "verify_overdue", alert: null, reviewCleared: true };
}

/**
 * The per-status GET handler of the sweep (T32-T35, T40, the C69 / §2.6.5
 * follow-ups, the C41 idle check), run once on a linked row: one GET mirrored
 * through §2.6.0 (observed_content_hash only, C66), then the CAS with the
 * bookkeeping. A gone row's flag is cleared only by a successful GET at or
 * after gone_at + 16 min that still answers gone / deleted (C17). Also serves
 * resolve {action: "check"} (T49) without a claim.
 */
export async function checkDraftOnce(principal: ExecPrincipal, row: ExecDraftRow, now: Date, opts: TransitionOptions = {}): Promise<CheckResult> {
  if (row.status === "sent_pending") {
    const anchor = Date.parse(row.sendAcceptedAt ?? row.sendStartedAt ?? row.createdAt);
    if (Number.isFinite(anchor) && now.getTime() - anchor >= DRAFT_LIMITS.sentPendingMaxMs) {
      const t = closeOverdue(row, now, opts);
      return { transition: t, read: null, applied: await casTransition(principal, row, t, now, "ok") };
    }
  }
  const answer = await cloneGet(principal, row);
  let t = mapGetResult(row, answer, now, opts);
  // An answer from the clone is a read or an error carrying the registry status (CL2C §3.3: a gone row
  // answers 404 gone with draftStatus); no answer, or an error without draftStatus, is a failed check.
  const answered = answer.ok || (!("noAnswer" in answer) && answer.error.draftStatus !== null);
  const failed = !answered;
  if (row.status === "gone" && row.goneUnconfirmed && answered && t.to === "gone") {
    const goneAt = Date.parse(row.goneAt ?? "");
    const confirmAfter = DRAFT_LIMITS.goneRecheckMs[DRAFT_LIMITS.goneRecheckMs.length - 1];
    if (Number.isFinite(goneAt) && now.getTime() >= goneAt + confirmAfter) {
      t = { ...t, patch: { ...t.patch, gone_unconfirmed: false, next_check_at: null } };
    }
  }
  const applied = await casTransition(principal, row, t, now, failed ? "failed" : "ok");
  alertTransition(t, row.id, "check");
  return { transition: t, read: answer.ok ? answer.value : null, applied };
}

// ---------------------------------------------------------------------------
// The replay of a stale `saving` row (C14, C67)
// ---------------------------------------------------------------------------

function ownDomainsOf(principal: ExecPrincipal): Set<string> {
  const at = principal.email.lastIndexOf("@");
  return new Set(at > 0 ? [principal.email.slice(at + 1).toLowerCase()] : []);
}

/** His addresses: principal.email and his pinned mailboxes' own addresses (mail/accounts), lowercased. */
function ownAddressesOf(principal: ExecPrincipal, accounts: readonly { id: string; email: string }[]): Set<string> {
  const pinned = new Set(pinnedAccounts(principal));
  const out = new Set<string>();
  const mine = principal.email.trim().toLowerCase();
  if (mine.includes("@")) out.add(mine);
  for (const a of accounts) if (pinned.has(a.id) && a.email.includes("@")) out.add(a.email.trim().toLowerCase());
  return out;
}

/** A promise raced against the replay's DD-side deadline (C67 (5)); the call keeps running, its answer is dropped. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<{ kind: "value"; value: T } | { kind: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
  });
  return Promise.race([p.then((value) => ({ kind: "value" as const, value })), deadline]).finally(() => clearTimeout(timer));
}

/**
 * The C11 render-time screen on a saving row before its replay (C67 (2)),
 * with the rules just loaded: P3's screenStoredRow on the row's own hashes,
 * then on the P3 thread row when there is one. The same rule as drafts.ts's
 * screenDraftRow, inlined so the handler stays below the service layer.
 */
function replayRestricted(row: ExecDraftRow, rules: readonly RestrictedSenderRule[], hash: string, p3Row: ThreadScreenRow | null): boolean {
  if (row.restrictedPurged) return true;
  if (row.kind !== "reply") return false;
  const own = screenStoredRow({ state: "triaged", screenHashes: row.screenHashes, screenTruncated: row.screenTruncated, screenedPolicyHash: row.screenedPolicyHash }, rules, hash);
  if (own.verdict === "restricted") return true;
  return p3Row !== null && screenStoredRow(p3Row, rules, hash).verdict === "restricted";
}

/** A saving row the sweep leaves for later: the code and + 5 min (or T52 once replayGiveUpMs has passed). */
function leaveSaving(row: ExecDraftRow, code: string | null, now: Date, opts: TransitionOptions): Transition {
  const started = Date.parse(row.saveStartedAt ?? "");
  if (Number.isFinite(started) && now.getTime() - started >= DRAFT_LIMITS.replayGiveUpMs) return giveUpSaving(row, now, opts);
  const patch: DraftPatch = {
    ...(code === null ? {} : { last_error_code: code, last_error_at: now.toISOString() }),
    next_check_at: nextCheckAt(row, now, "failed"),
    updated_at: now.toISOString()
  };
  return { to: "saving", patch, code, alert: null, reviewCleared: false };
}

/**
 * The run's clock and the end of its clone budget (data-5): a GET is started
 * only while one whole GET still fits, so a replay that ran long never pushes
 * the run past the job timeout; the row stays saving and the next run's replay
 * returns the stored answer.
 */
export interface RunBudget { clock: () => Date; endsAtMs: number }
const getFits = (b: RunBudget): boolean => b.clock().getTime() + GET_MS <= b.endsAtMs;

/**
 * §2.6.2's GET resolution of the old graphId: one GET, and one of `replacedBy`
 * when the old answered 404 deleted with one. null when the budget has no room
 * for it, or nothing answered (the caller keeps what it had).
 */
async function getResolution(principal: ExecPrincipal, row: ExecDraftRow, code: string, now: Date, opts: TransitionOptions, budget: RunBudget):
  Promise<Transition | null> {
  if (!getFits(budget)) return null;
  const old = await cloneGet(principal, row);
  let replacement: CloneAnswer<CloneDraftRead> | null = null;
  if (!old.ok && !("noAnswer" in old) && old.error.kind === "gone" && old.error.draftStatus === "deleted" && old.error.replacedBy) {
    if (!getFits(budget)) return null;
    replacement = await cloneGet(principal, row, old.error.replacedBy);
  }
  const r = resolveRecreateByGet(row, old, replacement, code, now, opts);
  return "leaveSaving" in r ? null : r;
}

/** §2.6.2's GET resolution of the old graphId (a purged recreate, whose body can't be rebuilt, C67 (4)). */
async function resolveByGet(principal: ExecPrincipal, row: ExecDraftRow, code: string, now: Date, opts: TransitionOptions, budget: RunBudget): Promise<Transition> {
  return (await getResolution(principal, row, code, now, opts, budget)) ?? leaveSaving(row, "outcome_unknown", now, opts);
}

/**
 * T52 (data-3): giving up on a recreate resolves the old graphId by GET first,
 * as T52 requires: still saved -> draft with the old link; deleted -> link NULL;
 * deleted with a replacement -> that replacement linked stale (linkReplacement).
 * Only when the GET has no answer (or no budget) is the old link kept. A create
 * has no link to resolve.
 */
async function giveUp(principal: ExecPrincipal, row: ExecDraftRow, now: Date, opts: TransitionOptions, budget: RunBudget): Promise<Transition> {
  if (!hasLink(row)) return giveUpSaving(row, now, opts);
  return (await getResolution(principal, row, "outlook_unknown", now, opts, budget)) ?? giveUpSaving(row, now, opts);
}
const isGiveUp = (t: Transition): boolean => t.to === "draft" && t.code === "outlook_unknown";

/**
 * The replayed GET of a linked saving row: a stored 2xx (this key's own result: §2.6.0's saving row writes the
 * link), or a replacement followed from a 404 gone / deleted (`follow`: an earlier attempt's draft, linked stale,
 * data-3). Skipped when the budget has no room for it (data-5).
 */
async function linkByGet(principal: ExecPrincipal, row: ExecDraftRow, graphId: string, now: Date, opts: TransitionOptions, budget: RunBudget, follow: boolean):
  Promise<Transition> {
  if (!getFits(budget)) return leaveSaving(row, "outcome_unknown", now, opts);
  const read = await cloneGet(principal, row, graphId);
  if (!read.ok) return leaveSaving(row, "outcome_unknown", now, opts);
  const t = follow
    ? linkReplacement(row, read.value, now, opts)
    : mirrorRegistry(row, { status: read.value.status, flags: read.value.flags, read: read.value }, now, opts);
  if (t.to === "saving") return leaveSaving(row, t.code, now, opts);
  return t;
}

async function replaySaving(principal: ExecPrincipal, row: ExecDraftRow, now: Date, opts: TransitionOptions, ownAddresses: ReadonlySet<string>,
  budget: RunBudget): Promise<Transition> {
  // C67 (4): a purged row is never replayed.
  if (row.restrictedPurged) {
    if (!hasLink(row)) return closePurgedCreate(row, now, opts);
    return resolveByGet(principal, row, "outlook_unknown", now, opts, budget);
  }
  const key = row.saveAttemptKey;
  const version = row.saveVersion ?? row.version;
  if (key === null || row.bodyHtml === null || row.saveTimezone === null) return giveUp(principal, row, now, opts, budget);

  // C67 (2): the audit row first; the screen and the recipient refusals with fresh rules.
  let auditId: number;
  try {
    auditId = await auditStart(principal, { actor: "job", action: "draft.save", target: `exec_drafts:${row.id}`, input: { draftId: row.id, version, replay: true } });
  } catch (err) {
    if (err instanceof AuditUnavailableError) {
      const left = leaveSaving(row, null, now, opts);
      return isGiveUp(left) ? giveUp(principal, row, now, opts, budget) : left;
    }
    throw err;
  }
  // Every T52 below (the 24 h give-up, a refused replay) is resolved by GET before it is recorded (data-3).
  const finish = async (t0: Transition, replay: boolean, resolved = false): Promise<Transition> => {
    const t = !resolved && isGiveUp(t0) ? await giveUp(principal, row, now, opts, budget) : t0;
    const ok = t.to === "saved";
    await auditFinish(auditId, { ok, result: { outcome: t.to, code: t.code, replay }, error: ok ? undefined : auditCode(t.code) });
    return t;
  };
  const policy = await loadScreeningPolicy(principal);
  const p3Row = row.kind === "reply" && row.threadId !== null ? await getEmailThread(principal, row.threadId) : null;
  if (replayRestricted(row, policy.rules, policy.hash, p3Row)) {
    if (row.threadId !== null) await purgeDraftsForThreads(principal, [row.threadId]);
    const purged = (await getDraft(principal, row.id)) ?? { ...row, restrictedPurged: true };
    const t = purged.status === "saving" ? await replaySaving(principal, { ...purged, restrictedPurged: true }, now, opts, ownAddresses, budget) : leaveSaving(row, null, now, opts);
    return finish(t, false, true);
  }
  const ctx: RecipientContext = {
    kind: row.kind,
    ownAddresses,
    internalDomains: ownDomainsOf(principal),
    restrictedRules: policy.rules,
    allowed: null,
    derivedTo: new Set(row.toRecipients.map((a) => a.address)),
    derivedCc: new Set(row.ccRecipients.map((a) => a.address)),
    expectedFrom: null
  };
  const check = checkRecipients({ to: row.toRecipients, cc: row.ccRecipients, bcc: row.bccRecipients }, ctx);
  if (!check.ok) return finish(giveUpSaving(row, now, opts), false);

  // (3) The same request, byte for byte, with the stored key; 150 s DD-side.
  const kind: "create" | "recreate" = hasLink(row) ? "recreate" : "create";
  const call = () => {
    if (kind === "recreate") {
      return recreateOutlookDraft(principal, {
        accountId: row.accountId,
        graphId: row.outlookGraphId as string,
        kind: row.kind,
        to: row.toRecipients,
        cc: row.ccRecipients,
        bcc: row.bccRecipients,
        subject: row.subject,
        bodyHtml: row.bodyHtml as string,
        timezone: row.saveTimezone as string,
        ifContentHash: row.saveIfContentHash,
        idempotencyKey: key
      });
    }
    if (row.kind === "reply") {
      return createReplyDraft(principal, {
        threadId: row.threadId as string,
        parentMessageId: row.parentMessageId as string,
        accountId: row.accountId,
        to: row.toRecipients,
        cc: row.ccRecipients,
        bodyHtml: row.bodyHtml as string,
        timezone: row.saveTimezone as string,
        idempotencyKey: key
      });
    }
    return createNewDraft(principal, {
      accountId: row.accountId,
      to: row.toRecipients,
      cc: row.ccRecipients,
      bcc: row.bccRecipients,
      subject: row.subject ?? "",
      bodyHtml: row.bodyHtml as string,
      timezone: row.saveTimezone as string,
      idempotencyKey: key
    });
  };
  let answer: CloneAnswer<Awaited<ReturnType<typeof call>>["readBack"]>;
  let replay = false;
  try {
    const raced = await withDeadline(call(), DRAFT_LIMITS.replayTimeoutMs);
    if (raced.kind === "timeout") answer = { ok: false, noAnswer: true };
    else {
      replay = raced.value.replay;
      answer = { ok: true, value: raced.value.readBack, replay };
    }
  } catch (err) {
    if (err instanceof CloneEaError) answer = { ok: false, error: err };
    else {
      console.warn(`[exec-drafts] replay of ${row.id} failed before an answer (${errorName(err)})`);
      answer = { ok: false, noAnswer: true };
    }
  }
  const mapped = mapReplayResult(row, kind, answer, now, opts);
  if ("needGet" in mapped) return finish(await linkByGet(principal, row, mapped.graphId, now, opts, budget, false), true);
  if ("leaveSaving" in mapped) return finish(leaveSaving(row, mapped.code, now, opts), replay);
  if (mapped.to === "saving" && mapped.code === "follow_replacement") {
    const replacedBy = !answer.ok && !("noAnswer" in answer) ? answer.error.replacedBy : null;
    return finish(replacedBy ? await linkByGet(principal, row, replacedBy, now, opts, budget, true) : leaveSaving(row, "outcome_unknown", now, opts), replay);
  }
  return finish(mapped, replay);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** T09: a generating row older than its stale window: generation_failed (a first generation) or back to prior_status (a regenerate). */
function staleGeneration(row: ExecDraftRow, now: Date): DraftPatch {
  if (row.priorStatus === null) return { status: "generation_failed", generation_error: "stale", prior_status: null, next_check_at: null, updated_at: now.toISOString() };
  return {
    status: priorStatusOf(row),
    generation_error: "stale",
    last_error_code: "generation_stale",
    last_error_at: now.toISOString(),
    prior_status: null,
    next_check_at: null,
    updated_at: now.toISOString()
  };
}

/** Readiness down: a clone row waits 5 min (C68); its check still counts. */
function postponed(row: ExecDraftRow, now: Date): DraftPatch {
  return { next_check_at: iso(now.getTime() + DRAFT_LIMITS.failedCheckRetryMs), check_count: row.checkCount + 1, updated_at: now.toISOString() };
}

async function readinessOf(principal: ExecPrincipal): Promise<EaReadiness | null> {
  try {
    return await getEaReadiness(principal);
  } catch (err) {
    console.warn(`[exec-drafts] reconcile: readiness could not be checked (${errorName(err)})`);
    return null;
  }
}

/**
 * The sweep (§3.11, C67). Returns counts only. Rows are listed once (≤ 20,
 * stale saving first), claimed one by one, and no row is started once the
 * start budget (170 s) is spent or the job signal aborted: the rest stay due.
 * At most one replay per run, started only within the first 60 s.
 */
export async function runDraftReconcile(input: { principal: ExecPrincipal; signal: AbortSignal; now?: () => Date }): Promise<ReconcileCounts> {
  const { principal, signal } = input;
  const now = input.now ?? (() => new Date());
  const started = now().getTime();
  const counts: ReconcileCounts = { checked: 0, transitions: 0, skipped: 0, kicked: false };
  const budget: RunBudget = { clock: now, endsAtMs: started + RUN_BUDGET_MS };

  const rows = await listDueDrafts(principal, now(), DUE_LIMIT);
  if (rows.length === 0) return counts;
  rows.sort((a, b) => {
    const sa = a.status === "saving" ? 0 : 1;
    const sb = b.status === "saving" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.nextCheckAt ?? "") < (b.nextCheckAt ?? "") ? -1 : (a.nextCheckAt ?? "") > (b.nextCheckAt ?? "") ? 1 : 0;
  });

  const settings = await loadSettings(principal.id);
  const opts: TransitionOptions = { retentionDays: settings.retentionDaysEmail };
  const accounts = (await getSyncState(principal, "mail", "accounts", parseAccountsState))?.value ?? null;
  const usable = usableAccounts(principal, problemAccountIds(accounts));
  const ownAddresses = ownAddressesOf(principal, accounts?.accounts ?? []);
  const needsClone = rows.some((r) => r.status !== "generating");
  const readiness = needsClone && pinnedAccounts(principal).length > 0 ? await readinessOf(principal) : null;
  const cloneReady = readiness !== null && readiness.ok;
  let replayed = false;

  for (const row of rows) {
    const elapsed = now().getTime() - started;
    if (elapsed > DRAFT_LIMITS.reconcileStartBudgetMs || signal.aborted) break;
    if (row.nextCheckAt === null) {
      counts.skipped += 1;
      continue;
    }
    // C67 (5): one replay per run, started within its first 60 s; another stale save is left due (not claimed).
    // A purged row is never replayed (C67 (4)), so it doesn't take the run's one replay.
    const replay = row.status === "saving" && !row.restrictedPurged && cloneReady && usable.includes(row.accountId);
    if (replay && (replayed || elapsed > DRAFT_LIMITS.replayStartWithinMs)) {
      counts.skipped += 1;
      continue;
    }
    const claimed = await claimDueDraft(principal, row.id, row.nextCheckAt, iso(now().getTime() + DRAFT_LIMITS.claimMs));
    if (!claimed) {
      counts.skipped += 1;
      continue;
    }
    counts.checked += 1;
    const at = now();
    try {
      if (row.status === "generating") {
        if (await casDraft(principal, row.id, casExpectFor(row), staleGeneration(row, at))) counts.transitions += 1;
        continue;
      }
      if (!cloneReady || !usable.includes(row.accountId)) {
        // data-6, C67 (3): a save still unresolved 24 h after it started gives up (T52) even while the clone or the
        // mailbox is down; the link is kept (no GET can resolve it now). Everything else waits 5 min.
        const saveStarted = Date.parse(row.saveStartedAt ?? "");
        if (row.status === "saving" && Number.isFinite(saveStarted) && at.getTime() - saveStarted >= DRAFT_LIMITS.replayGiveUpMs) {
          if ((await casTransition(principal, row, giveUpSaving(row, at, opts), at, "ok")) === "applied") counts.transitions += 1;
          continue;
        }
        await casDraft(principal, row.id, casExpectFor(row), postponed(row, at));
        continue;
      }
      if (row.status === "saving") {
        if (replay) replayed = true;
        const t = await replaySaving(principal, row, at, opts, ownAddresses, budget);
        const outcome = await casTransition(principal, row, t, at, t.to === "saving" ? "failed" : "ok");
        if (outcome === "applied" && t.to !== "saving") counts.transitions += 1;
        alertTransition(t, row.id, "replay");
        continue;
      }
      const r = await checkDraftOnce(principal, row, at, opts);
      if (r.applied === "applied" && r.transition.to !== row.status) counts.transitions += 1;
      // T31/T32: a send whose request died before auditFinish; the outcome is known now.
      if (row.status === "sending" && r.transition.to !== "sending" && row.sentAuditId !== null && r.applied === "applied") {
        const ok = r.transition.to === "sent_pending" || r.transition.to === "sent";
        await auditFinish(row.sentAuditId, { ok, result: { outcome: r.transition.to, code: r.transition.code }, error: ok ? undefined : auditCode(r.transition.code) });
      }
    } catch (err) {
      console.warn(`[exec-drafts] reconcile ${row.id} (${row.status}): ${errorName(err)}`);
      try {
        await casDraft(principal, row.id, casExpectFor(row), postponed(row, at));
      } catch (inner) {
        console.warn(`[exec-drafts] reconcile ${row.id}: could not postpone (${errorName(inner)})`);
      }
    }
  }

  // C18: one follow-up kick for the earliest due row within 5 min.
  try {
    const due = await earliestDueWithin(principal, now(), KICK_WINDOW_MS);
    if (due !== null) {
      const dueMs = Math.max(Date.parse(due), now().getTime());
      await enqueueJob(draftReconcileKick(principal, new Date(dueMs), `t${Math.floor(dueMs / 10_000)}`));
      counts.kicked = true;
    }
  } catch (err) {
    console.warn(`[exec-drafts] reconcile: the follow-up kick was not queued (${errorName(err)})`);
  }
  return counts;
}

async function runReconcile(ctx: JobContext): Promise<ReconcileCounts> {
  const { job, principal, signal } = ctx;
  if (!principal) throw new NonRetryableError(`${KIND}: job ${job.id} has no principal`);
  return runDraftReconcile({ principal, signal });
}

export const draftReconcileJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: DRAFT_RECONCILE_TIMEOUT_MS,
  run: (ctx: JobContext) => runReconcile(ctx)
};

/** Every 5 minutes on the bulk lane while the drafts schema is installed and a row is due (Y4 `when`); 2 attempts. */
export const draftReconcileScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: 5 },
  enabled: (s) => s.draftsSchemaReady,
  when: (p, _s, now) => hasDueDrafts(p, now),
  maxAttempts: 2
};

/**
 * C18: an interactive kick 25 s after a send or an "open in Outlook" (or the
 * sweep's own follow-up), deduped by `tag`: a<16 hex of sha256(send key)>,
 * o<draftId>:<epochMinute>, or t<floor(dueMs / 10 000)>.
 */
export function draftReconcileKick(principal: ExecPrincipal, runAfter: Date, tag: string): EnqueueJobInput {
  if (!(runAfter instanceof Date) || !Number.isFinite(runAfter.getTime())) throw new NonRetryableError(`${KIND}: runAfter must be a valid Date`);
  if (typeof tag !== "string" || !KICK_TAG_RE.test(tag)) throw new NonRetryableError(`${KIND}: the kick tag is malformed`);
  return {
    kind: KIND,
    lane: "interactive",
    principalId: principal.id,
    payload: { kick: true },
    dedupeKey: `draft-recon:${principal.id}:${tag}`,
    runAfter,
    maxAttempts: 1
  };
}

/** The kick delay after a send or an open in Outlook (C18, C69). */
export const KICK_DELAY_MS = 25_000;
export const KICK_MINUTE_MS = MIN_MS;
