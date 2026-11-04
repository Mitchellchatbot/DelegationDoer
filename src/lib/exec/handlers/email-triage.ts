import "server-only";

import { loadClientMatcher, matchThreadClient } from "@/lib/exec/correlate";
import {
  applyThreadProposal,
  getEmailThread,
  listCommitmentMessageIds,
  listCommitments,
  listSignalsForMessages,
  setCommitmentStatus,
  type ApplyResult
} from "@/lib/exec/email-store";
import {
  toMs,
  type ReadScreen,
  type ThreadFacts,
  type ThreadProposal,
  type TriageAiFields,
  type TriageOutcomeProposal,
  type TriageRunFields
} from "@/lib/exec/email-state";
import {
  CORRESPONDENTS_LIMIT,
  EMAIL_BACKFILL_DAYS,
  NEW_MARK_SETTLE_MS,
  type ClientMatchVia,
  type CommitmentDirection,
  type ExecEmailThread,
  type HisMessage,
  type MatchConfidence,
  type NewCommitment,
  type PrincipalMailThread
} from "@/lib/exec/email-types";
import { EMAIL_TRIAGE_JOB_KIND, enqueueBulkTriage, kickAttention, mailBacklogKey, parseTriagePayload } from "@/lib/exec/jobs";
import { EXEC_MODELS } from "@/lib/exec/llm/models";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import {
  computeAnswered,
  isPartialThread,
  loadHisBodies,
  loadScreeningPolicy,
  pinnedAccounts,
  readPrincipalThread,
  screenByHashes,
  screenHashesFor,
  screenRestricted,
  usableAccounts,
  type AnsweredFacts
} from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, problemAccountIds, type AccountsState } from "@/lib/exec/sync-state";
import { prefilter, runTriageModel, triageContentHash, TRIAGE_VERSION, type TriageModelOutcome, type TriageResult } from "@/lib/exec/triage/email";
import { MAX_RENDERED_MESSAGES, renderTriageInput, type RenderedTriageInput } from "@/lib/exec/triage/email-text";
import { NonRetryableError, type ExecPrincipal, type JobContext, type JobHandler, type JobLane } from "@/lib/exec/types";

// exec.email-triage: one thread of his, read from the clone, screened,
// assessed and written through the state machine (contract §3.11, as amended
// by v3.1 A1-A7 and the round-4 addenda).
//
// The order of the steps is the point:
//   - The restricted-sender screen runs on the live read, and on the row's
//     stored hashes, before anything else can happen to a thread that already
//     has a row (A7): a restricted thread
//     becomes a tombstone before any exit, and a clean read that exits early
//     still unions its screening hashes into the row (coherence-20), so a rule
//     added later sees every address the thread was ever read with.
//   - Nothing reaches the model until the thread is known to be his, not junk,
//     not restricted, and not filtered.
//   - The rules are loaded again just before the write; a rule added while
//     the model ran turns the write into a tombstone. The store reloads them
//     once more for every compare-and-set attempt (A1).
//   - Content-level failures (refusal, a cut-off or invalid answer, the daily
//     cap, an input too large) are outcomes the state machine stores; only
//     infrastructure failures throw, and the runner retries those (L6).
//
// Logs, ops alerts and the job result carry ids, counts and codes only.

export const EMAIL_TRIAGE_TIMEOUT_MS = 120_000;
/** Every clone call in a job (contract §0). */
const CLONE_TIMEOUT_MS = 30_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** An interactive event for a message sent longer ago than this is backlog (a reconnect replay): it moves to the bulk lane (L10). */
export const BACKLOG_AGE_MS = 2 * HOUR_MS;
const BACKFILL_MS = EMAIL_BACKFILL_DAYS * DAY_MS;

// ---------------------------------------------------------------------------
// The client matcher (Area E, correlate.ts §3.12), as this handler uses it
// ---------------------------------------------------------------------------

/** One thread's client match (L14). */
export interface TriageClientMatch {
  clientId: string | null;
  clientName: string | null;
  via: ClientMatchVia | null;
  confidence: MatchConfidence | null;
  /** Distinct active clients that matched (more than one → low confidence). */
  candidates: number;
}

/** What steps 8-10 need from E's ClientMatcher, loaded once per job. */
export interface TriageMatcher {
  /** matchThreadClient: his inbound senders newest first, else his outbound recipients (§3.12). */
  matchThread(t: PrincipalMailThread): TriageClientMatch;
  /** The team's own addresses and domains (L14), for the owed-to-him follow-up rule. */
  isInternal(email: string): boolean;
}

export interface EmailTriageDeps {
  loadMatcher: (principal: ExecPrincipal, opts: { signal: AbortSignal }) => Promise<TriageMatcher>;
}

// ---------------------------------------------------------------------------
// The job's result: counts and codes only (boundary rule 9)
// ---------------------------------------------------------------------------

export interface TriageJobSummary {
  /** What the job decided. */
  outcome: "triaged" | "filtered" | "failed" | "deferred_budget" | "unchanged" | "tombstoned" | "gone" | "skipped" | "deferred";
  /** The store's answer, when the job wrote. */
  write?: ApplyResult["result"];
  /** A skip or deferral code, or the store's skip reason. */
  why?: string;
  commitmentsInserted?: number;
  followedUp?: number;
  enqueued?: number;
  modelCalled?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const msOf = (iso: string | null | undefined): number | null => toMs(iso);

function sentMs(m: Pick<HisMessage, "sentAt" | "createdAtMs">): number | null {
  return msOf(m.sentAt) ?? m.createdAtMs ?? null;
}

/** His own addresses: his DD email and every pinned mailbox's address. A copy of his own mail is not mail to him. */
export function ownAddressesOf(principal: ExecPrincipal, accounts: AccountsState | null): Set<string> {
  const own = new Set<string>([principal.email.trim().toLowerCase()]);
  for (const a of accounts?.accounts ?? []) if (a.email) own.add(a.email.trim().toLowerCase());
  return own;
}

/** The max clone ingest time over his non-junk messages: the outcome's watermark (§3.2(f)). null when none carried one. */
export function watermarkOf(mine: readonly HisMessage[]): number | null {
  let w: number | null = null;
  for (const m of mine) if (typeof m.createdAtMs === "number" && Number.isFinite(m.createdAtMs)) w = w === null ? m.createdAtMs : Math.max(w, m.createdAtMs);
  return w;
}

/**
 * The display facts of one read, his messages only (L11): subject from his
 * newest message, the counterpart (the newest inbound sender, else the first
 * recipient of his newest outbound), up to CORRESPONDENTS_LIMIT addresses
 * newest first without his own, and the deterministic answered facts.
 */
export function buildFacts(
  t: PrincipalMailThread,
  mine: readonly HisMessage[],
  answered: AnsweredFacts,
  match: TriageClientMatch,
  own: ReadonlySet<string>
): ThreadFacts {
  const newest = mine[mine.length - 1];
  const counterpart = answered.newestInbound?.from ?? [...(answered.newestOutbound?.to ?? []), ...(answered.newestOutbound?.cc ?? [])][0] ?? null;
  const correspondents: string[] = [];
  for (let i = mine.length - 1; i >= 0 && correspondents.length < CORRESPONDENTS_LIMIT; i -= 1) {
    const m = mine[i];
    for (const a of [...(m.from ? [m.from] : []), ...m.to, ...m.cc]) {
      if (correspondents.length >= CORRESPONDENTS_LIMIT) break;
      if (!own.has(a.email) && !correspondents.includes(a.email)) correspondents.push(a.email);
    }
  }
  return {
    accountId: newest.accountId,
    subject: newest.subject || null,
    counterpartName: counterpart?.name ?? null,
    counterpartEmail: counterpart?.email ?? null,
    correspondents,
    messageCount: mine.length,
    newestMessageId: answered.newestMessage?.id ?? newest.id,
    newestInboundMessageId: answered.newestInbound?.id ?? null,
    newestOutboundMessageId: answered.newestOutbound?.id ?? null,
    lastInboundAt: answered.lastInboundAt,
    lastOutboundAt: answered.lastOutboundAt,
    newestIsOutbound: answered.newestIsOutbound,
    answeredState: answered.state,
    answeredAt: answered.answeredAt,
    answeredMessageId: answered.answeredMessageId,
    partialThread: isPartialThread(t.his, t.all),
    outboundAutomatedOnly: answered.outboundAutomatedOnly,
    clientId: match.clientId,
    clientName: match.clientName,
    clientMatchVia: match.via,
    matchConfidence: match.confidence,
    clientCandidates: Number.isSafeInteger(match.candidates) && match.candidates > 0 ? match.candidates : 0
  };
}

/**
 * Step 9's rule: the message that followed a commitment up, if any.
 * mitchell_owes: a later outbound of his that isn't automated.
 * owed_to_mitchell: a later inbound from outside the team (not internal, not his own).
 */
export function followUpOf(
  direction: CommitmentDirection,
  messageSentAt: string,
  mine: readonly HisMessage[],
  isInternal: (email: string) => boolean,
  own: ReadonlySet<string>
): HisMessage | null {
  const since = msOf(messageSentAt);
  if (since === null) return null;
  for (const m of mine) {
    const at = sentMs(m);
    if (at === null || at <= since) continue;
    if (direction === "mitchell_owes") {
      if (m.direction === "outbound" && !m.isAutomated) return m;
    } else if (m.direction === "inbound" && m.from !== null && !own.has(m.from.email) && !isInternal(m.from.email)) {
      return m;
    }
  }
  return null;
}

function aiFieldsOf(r: TriageResult): TriageAiFields {
  return {
    summary: r.summary,
    reason: r.reason,
    category: r.category,
    urgency: r.urgency,
    importance: r.importance,
    needsReply: r.needsReply,
    mitchellPersonally: r.mitchellPersonally,
    awaitingReplyFromOthers: r.awaitingReplyFromOthers,
    decisionQuestion: r.decisionQuestion,
    decisionMessageId: r.decisionMessageId,
    clientSignal: r.clientSignal,
    automated: r.automated,
    injectionSuspected: r.injectionSuspected
  };
}

/**
 * Step 11's short-cut (coherence-14, amendments-9): the same rendered input
 * was already assessed through at least this watermark, and that assessment
 * stands (triaged), or the model refused exactly this input. A refusal isn't
 * re-sent while the input is unchanged; an Assess always is.
 */
export function isUnchanged(stored: ExecEmailThread | null, contentHash: string, w: number | null, force: boolean): boolean {
  if (stored === null || force || stored.contentHash !== contentHash) return false;
  const standing = stored.state === "triaged" || (stored.state === "triage_failed" && stored.triageError === "refusal");
  if (!standing) return false;
  if (w === null) return true;
  const s = msOf(stored.outcomeWatermark);
  return s !== null && s >= w;
}

/** The model's answer as a state-machine outcome (step 12): content-level failures are outcomes, never throws. */
export function outcomeOf(answer: TriageModelOutcome, w: number | null, run: (model: string) => TriageRunFields): TriageOutcomeProposal {
  switch (answer.kind) {
    case "ok":
      return { kind: "triaged", watermarkMs: w, ai: aiFieldsOf(answer.result), run: run(answer.call.model) };
    case "refused":
      return { kind: "failed", watermarkMs: w, error: "refusal", refusalCategory: answer.refusalCategory, run: run(answer.call.model) };
    case "truncated":
      return { kind: "failed", watermarkMs: w, error: "truncated", refusalCategory: null, run: run(answer.call.model) };
    case "invalid_output":
      return { kind: "failed", watermarkMs: w, error: "invalid_output", refusalCategory: null, run: run(answer.call.model) };
    case "input_too_large":
      // No call was made; the row still records which model the input was too large for.
      return { kind: "failed", watermarkMs: w, error: "input_too_large", refusalCategory: null, run: run(EXEC_MODELS.triage) };
    case "budget":
      return { kind: "deferred_budget", watermarkMs: w };
  }
}

/** The newest MAX_RENDERED_MESSAGES of his non-junk messages, in the renderer's order. */
function newestShown(mine: readonly HisMessage[]): HisMessage[] {
  const sorted = [...mine].sort((a, b) => (msOf(a.sentAt) ?? 0) - (msOf(b.sentAt) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.slice(-MAX_RENDERED_MESSAGES);
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

async function runTriage(ctx: JobContext, deps: EmailTriageDeps): Promise<TriageJobSummary> {
  const { job, principal, signal } = ctx;
  // The hook, reconcile, the sweeps and the assess route always enqueue for a
  // principal with a payload built by triageJob(); anything else is a bug a
  // retry won't fix.
  if (!principal) throw new NonRetryableError(`${EMAIL_TRIAGE_JOB_KIND}: job ${job.id} has no principal`);
  const payload = parseTriagePayload(job.payload);
  if (!payload) throw new NonRetryableError(`${EMAIL_TRIAGE_JOB_KIND}: job ${job.id} has a malformed payload`);
  const threadId = payload.threadId;
  const lane: JobLane = job.lane;
  const force = payload.force === true;

  // 1. Gate (L1): installed, switched on, a pin; then the usable accounts.
  const settings = await loadSettings(principal.id);
  if (!settings.emailSchemaReady) return { outcome: "skipped", why: "not_installed" };
  if (!settings.emailEnabled) return { outcome: "skipped", why: "email_off" };
  if (pinnedAccounts(principal).length === 0) return { outcome: "skipped", why: "no_pin" };
  const accounts = (await getSyncState(principal, "mail", "accounts", parseAccountsState, { signal }))?.value ?? null;
  const usable = usableAccounts(principal, problemAccountIds(accounts));
  if (usable.length === 0) return { outcome: "skipped", why: "no_usable_account" };
  if (payload.accountId !== undefined && !usable.includes(payload.accountId)) return { outcome: "skipped", why: "account_not_usable" };

  // 1b. The stored row, before the read: it decides whether the early screen runs (coherence-20).
  const stored = await getEmailThread(principal, threadId, { signal });
  const applyCtx = () => ({ now: new Date(), retentionDays: settings.retentionDaysEmail });

  // 2. The policy this read is screened under (strict: a failed rules read throws and the job retries).
  const policy1 = await loadScreeningPolicy(principal, { signal });

  // 3. Read.
  const read = await readPrincipalThread(principal, threadId, { usable, timeoutMs: CLONE_TIMEOUT_MS, signal });
  if (read.kind === "not_found") {
    // The clone's own 404: permanent (thread ids are never reused). "Gone at"
    // is the 404 read's own readDoneAtMs (amendments-7(a)), so no read that
    // overlapped it can revive the row.
    const r = await applyThreadProposal(principal, settings, threadId, { kind: "gone", atMs: read.readDoneAtMs }, applyCtx(), { signal });
    if (r.result !== "skipped") await kickAttention(principal, lane);
    return { outcome: "gone", write: r.result, ...(r.reason ? { why: r.reason } : {}) };
  }
  if (read.kind === "not_his") return { outcome: "skipped", why: "not_his" };
  const t = read.thread;

  // The live screen (L2): every message of the thread, any account, plus its participants.
  const hashes = screenHashesFor(t);
  const live: ReadScreen = { verdict: screenRestricted(t, policy1.rules).verdict, hashes: hashes.hashes, truncated: hashes.truncated };
  const newestOfHis = t.his[t.his.length - 1];

  const tombstone = async (policyHash: string): Promise<TriageJobSummary> => {
    const r = await applyThreadProposal(
      principal,
      settings,
      threadId,
      { kind: "tombstone", snapshot: t.snapshot, hashes: live.hashes, truncated: live.truncated, policyHash, accountId: newestOfHis.accountId },
      applyCtx(),
      { signal }
    );
    await kickAttention(principal, lane);
    return { outcome: "tombstoned", write: r.result };
  };

  // 3b. A thread that already has a row is screened before any exit (A7):
  // the live read, and the stored hashes with it (security-2). Stored hashes
  // only grow (A1), so an address the clone no longer has (a purge-by-sender,
  // a split re-point) still counts, exactly as the store's union screen will
  // count it at the write. A row that write would turn into a tombstone is
  // tombstoned here instead, before any body is loaded or the model sees the
  // thread. Unreadable stored hashes can't be screened: fail closed.
  if (stored !== null) {
    const storedHashes = Array.isArray(stored.screenHashes) ? stored.screenHashes : null;
    if (
      live.verdict === "restricted" ||
      storedHashes === null ||
      screenByHashes([...new Set([...storedHashes, ...live.hashes])], policy1.rules).verdict === "restricted"
    ) {
      return tombstone(policy1.hash);
    }
  }

  // An exit after a clean read still keeps the read's hashes on the row
  // (coherence-20, amendments-2(a)): the hashes proposal unions them and
  // stamps the policy only when that is provably right. It can still turn
  // into a tombstone (the store screens the union under the rules it reloads).
  const unionHashes = async (): Promise<ApplyResult | null> => {
    if (stored === null) return null;
    const r = await applyThreadProposal(
      principal,
      settings,
      threadId,
      { kind: "hashes", snapshot: t.snapshot, screen: live, policyHash: policy1.hash },
      applyCtx(),
      { signal }
    );
    if (r.result === "tombstoned") await kickAttention(principal, lane);
    return r;
  };
  const exitAfterRead = async (why: string): Promise<TriageJobSummary> => {
    const r = await unionHashes();
    if (r === null) return { outcome: "skipped", why };
    return { outcome: r.result === "tombstoned" ? "tombstoned" : "skipped", why, write: r.result };
  };

  // 4. The message the job is about must be in this thread, on a usable account of his.
  if (payload.messageId !== undefined) {
    const m = t.all.find((x) => x.id === payload.messageId);
    if (!m || m.accountId === null || !usable.includes(m.accountId)) return exitAfterRead("message_not_in_thread");
    // Backlog (L10): an interactive event for old mail is a replay; it moves
    // to the bulk lane at the shared stagger. If the bulk cap is full it isn't
    // queued at all, and reconcile finds the message again on its next run.
    const sent = msOf(m.sentAt) ?? m.createdAtMs;
    if (lane === "interactive" && payload.reason === "event" && sent !== null && Date.now() - sent > BACKLOG_AGE_MS) {
      const r = await unionHashes();
      if (r?.result === "tombstoned") return { outcome: "tombstoned", why: "backlog", write: r.result };
      const moved = await enqueueBulkTriage(
        principal,
        [{ threadId, reason: "event", dedupeKey: mailBacklogKey(principal.id, payload.messageId), messageId: payload.messageId, accountId: m.accountId }],
        new Date(),
        { signal }
      );
      return {
        outcome: "deferred",
        why: moved.blocked > 0 ? "backpressure" : "backlog",
        enqueued: moved.enqueued,
        ...(r ? { write: r.result } : {})
      };
    }
  }

  // 5. Junk only: nothing of his to assess.
  const mine = t.his.filter((m) => !m.isJunk);
  if (mine.length === 0) return exitAfterRead("junk_only");

  // 6. Age gate: a thread with no row whose newest mail is older than the backfill window is not picked up.
  const newestMs = sentMs(mine[mine.length - 1]);
  if (stored === null && newestMs !== null && Date.now() - newestMs > BACKFILL_MS) return { outcome: "skipped", why: "too_old" };

  // 7. The screen, for a thread with no row (A7 ran it already for the others).
  if (live.verdict === "restricted") return tombstone(policy1.hash);

  // 8. Facts.
  const own = ownAddressesOf(principal, accounts);
  const answered = computeAnswered(t.his, { ownAddresses: own });
  const matcher = await deps.loadMatcher(principal, { signal });
  const match = matcher.matchThread(t);
  const facts = buildFacts(t, mine, answered, match, own);

  // 9. Follow-ups: an open commitment the thread has since acted on.
  let followedUp = 0;
  const open = await listCommitments(principal, { statuses: ["open"], threadIds: [threadId] }, { signal });
  for (const c of open) {
    const by = followUpOf(c.direction, c.messageSentAt, mine, (e) => matcher.isInternal(e), own);
    if (!by) continue;
    await setCommitmentStatus(principal, c.id, "followed_up", by.sentAt, { signal, expectStatus: "open" });
    followedUp += 1;
  }

  // 10. The watermark (before the prefilter), then the prefilter (L7). The
  // flag comes from the anchor's stored CL1 signals row (coherence-8).
  const w = watermarkOf(mine);
  const anchorId = answered.anchorMessageId;
  const flagged = anchorId !== null && (await listSignalsForMessages(principal, [anchorId], { signal })).get(anchorId)?.flagged === true;
  const filter = prefilter({
    newestInbound: answered.newestInbound,
    hasInbound: answered.newestInbound !== null,
    hasPriorReply: mine.some((m) => m.direction === "outbound" && !m.isAutomated),
    exactClientContact: match.via === "exact" && match.clientId !== null,
    outlookFlagged: flagged,
    outboundAutomatedOnly: answered.outboundAutomatedOnly,
    force
  });

  let outcome: TriageOutcomeProposal;
  let commitments: NewCommitment[] = [];
  let refusalCategory: string | null | undefined;
  let modelCalled = false;
  if (filter.filtered) {
    outcome = { kind: "filtered", watermarkMs: w, reason: filter.reason };
  } else {
    // 11. Render (bodies of the messages shown, newest first), then the content hash.
    const shown = newestShown(mine);
    await loadHisBodies(
      principal,
      t,
      [...shown].reverse().filter((m) => m.bodyDeferred).map((m) => m.id),
      { signal, timeoutMs: CLONE_TIMEOUT_MS }
    );
    const storedInputMs = stored === null ? null : msOf(stored.inputWatermark);
    const extracted = stored === null ? [] : [...(await listCommitmentMessageIds(principal, threadId, { signal }))];
    const rendered: RenderedTriageInput = renderTriageInput({
      owner: principal,
      threadId,
      messages: mine,
      // [NEW] with A5's settled margin: a message committed late, behind a newer one, still counts as new.
      newSinceWatermarkMs: storedInputMs === null ? null : storedInputMs - NEW_MARK_SETTLE_MS,
      client:
        match.clientId !== null || match.candidates > 1
          ? { name: match.clientName, confidence: match.confidence ?? "low", via: match.via, candidates: match.candidates }
          : null,
      alreadyExtractedMessageIds: extracted
    });
    const contentHash = triageContentHash({ canonical: rendered.canonical, clientId: match.clientId, confidence: match.confidence });
    const run = (model: string): TriageRunFields => ({
      contentHash,
      model,
      triageVersion: TRIAGE_VERSION,
      inputTruncated: rendered.truncated,
      bodySource: rendered.bodySource
    });

    if (isUnchanged(stored, contentHash, w, force)) {
      outcome = { kind: "unchanged", watermarkMs: w };
    } else {
      // 12. Model. A first assessment (no triaged write yet, or a tombstone
      // being left) may take commitments from any message.
      const firstTriage = stored === null || stored.inputWatermark === null;
      const answer = await runTriageModel(principal, rendered, { firstTriage, signal });
      modelCalled = answer.kind !== "budget" && answer.kind !== "input_too_large";
      outcome = outcomeOf(answer, w, run);
      if (answer.kind === "refused") refusalCategory = answer.refusalCategory;
      if (answer.kind === "ok") {
        commitments = answer.result.commitments.map((c) => ({
          ...c,
          bornFollowedUpAt: followUpOf(c.direction, c.messageSentAt, mine, (e) => matcher.isInternal(e), own)?.sentAt ?? null
        }));
      }
    }
  }

  // 13. Write: the rules once more, then the store (which reloads them per attempt).
  const policy2 = await loadScreeningPolicy(principal, { signal });
  if (policy2.hash !== policy1.hash && screenRestricted(t, policy2.rules).verdict === "restricted") return tombstone(policy2.hash);
  const proposal: ThreadProposal = {
    kind: "triage",
    snapshot: t.snapshot,
    // The hashes don't depend on the rules; the verdict was just re-checked
    // under policy2 when the policy moved, and is clean.
    screen: { ...live, verdict: "clean" },
    policyHash: policy2.hash,
    facts,
    outcome,
    commitments
  };
  const r = await applyThreadProposal(principal, settings, threadId, proposal, applyCtx(), { signal });

  // 14. Finish.
  if (r.result !== "skipped") await kickAttention(principal, lane);
  if (refusalCategory !== undefined) {
    const category = refusalCategory ?? "uncategorized";
    await notifyOps({ key: `email-triage-refusal:${principal.id}`, title: "email triage refused a thread", detail: `thread ${threadId} (${category})` });
  }
  return {
    outcome: r.result === "tombstoned" ? "tombstoned" : outcome.kind,
    write: r.result,
    ...(r.reason ? { why: r.reason } : {}),
    commitmentsInserted: r.commitments.length,
    followedUp,
    modelCalled
  };
}

/** The triage handler over these dependencies (tests inject a matcher). */
export function createEmailTriageHandler(deps: EmailTriageDeps): JobHandler {
  return Object.freeze<JobHandler>({
    kind: EMAIL_TRIAGE_JOB_KIND,
    lane: "interactive",
    timeoutMs: EMAIL_TRIAGE_TIMEOUT_MS,
    run: (ctx) => runTriage(ctx, deps)
  });
}

/**
 * E's matcher (correlate.ts): the active clients' match signals and the
 * team's own addresses, read fresh for each job. Either read failing throws
 * and the job retries: a matcher built from nothing would call every client
 * email "no client" and let the prefilter drop exact client contacts.
 */
export async function loadTriageMatcher(principal: ExecPrincipal, opts: { signal: AbortSignal }): Promise<TriageMatcher> {
  const matcher = await loadClientMatcher(principal, { signal: opts.signal, timeoutMs: CLONE_TIMEOUT_MS });
  return {
    matchThread: (t) => {
      const f = matchThreadClient(t, matcher);
      return { clientId: f.clientId, clientName: f.clientName, via: f.clientMatchVia, confidence: f.matchConfidence, candidates: f.clientCandidates };
    },
    isInternal: (email) => matcher.isInternal(email)
  };
}

/** exec.email-triage as registered (runtime.ts). */
export const emailTriageJobHandler: JobHandler = createEmailTriageHandler({ loadMatcher: loadTriageMatcher });
