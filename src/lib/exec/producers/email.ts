import "server-only";

import { createHash } from "node:crypto";
import { ATTENTION_LIMITS, emailClientFingerprint, emailCommitmentFingerprint, emailThreadFingerprint } from "@/lib/exec/attention";
import type { AttentionCandidate, AttentionCategory, AttentionFact, FactBasis } from "@/lib/exec/attention-types";
import { isActiveClientStatus } from "@/lib/exec/correlate";
import type { ProducerThreadRow } from "@/lib/exec/email-store";
import type { AnsweredState, ClientSignal, ExecCommitment, ExecEmailSignal, ReplyArtifacts, ThreadScreenRow } from "@/lib/exec/email-types";
import { formatInZone, pluralize } from "@/lib/exec/format";
import { scorePriority, type AttentionKind, type PriorityFactors } from "@/lib/exec/priority";
import { clipExcerpt, ddClientRef, execEmailRef, execEmailThreadRef } from "@/lib/exec/refs";
import type { ClientHealthLabel, DdClient, DdSatisfactionSignal } from "@/lib/exec/sources/dd-types";
import { overlayAnswered, screenStoredRow } from "@/lib/exec/sources/mail";
import type { SourceRef } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// Needs Attention from his email (contract §3.13, L4, L12, L13, A2): pure,
// over what the attention pass (handlers/email-attention.ts) has read.
//
//   client_escalation        a client thread (a high- or medium-confidence
//                            match) that the triage read as a complaint, a
//                            churn risk, an outage, a billing or legal dispute,
//                            or critical/high urgency, still awaiting his
//                            reply, last inbound within 14 days
//   decision_ask             a thread that asks him for a decision (the AI's
//                            decision question), awaiting reply, within 30 days
//   important_email          a thread that needs his reply (awaiting, within
//                            30 days) and is urgent, important, flagged, from a
//                            client, needs him personally, or has waited 3+
//                            days (my_action); or an important or flagged one
//                            that needs no reply, from the last 7 days (fyi)
//   overdue_commitment       an open commitment past its due date, at most 30
//                            days (the pass expires older ones)
//   client_satisfaction_drop low AI satisfaction scores (55 or less) on a fresh
//                            client's inbound mail in the last 7 days
//   client_health_drop       a client whose health label fell a band in the
//                            last 7 days and is still down (exec's snapshot)
//
// One item per thread, with one anchor (L4): the newest inbound message, or
// the newest message of an outbound-only thread. A thread that qualifies for
// several kinds gets the strongest (escalation, then decision, then
// important); the kind changes in place, because the fingerprint doesn't name
// it. A new inbound message moves the anchor, so a new email is a new item
// even after he dismissed the last one.
//
// The restricted-sender screen runs first, on every row (A2): a producer row,
// and each commitment's own thread row, must pass screenStoredRow under the
// rules and the policy hash the pass just loaded. A row that fails makes no
// item, and nothing hangs off it.
//
// Honesty (plan §2 rule 6): the AI's assessment (summary, reason, decision
// question, urgency, client signal, the satisfaction scores, the extracted
// commitments) is a fact of basis "ai"; the answered state, ages and the
// client match are "derived"; Outlook's flag and the dates are "record".
// whatHappened is built from records only; whyItMatters says "AI-assessed"
// when it leans on the model. recommendedNext comes from fixed templates.
//
// What an item may carry (§0 + A7): at most 120 characters of the subject in
// the title, the subject as a ref label, the clipped AI fields in facts, and
// on a commitment item its text, counterparty and due text. Never an address,
// a body, or a commitment's evidence quote.
//
// State hashes (16 hex of sha256) take no time inputs, so a refresh that
// finds nothing new leaves a seen item seen; ages move the score only.

/** Every kind this producer emits: the scope its sync resolves within. */
export const EMAIL_ATTENTION_KINDS: readonly AttentionKind[] = Object.freeze([
  "important_email",
  "client_escalation",
  "decision_ask",
  "overdue_commitment",
  "client_satisfaction_drop",
  "client_health_drop"
]);

const DAY_MS = 86_400_000;

/** Reply and decision window (L12's "Needs your reply"). */
export const REPLY_WINDOW_DAYS = 30;
/** Escalations: the Urgent bucket's window (L12). */
export const ESCALATION_WINDOW_DAYS = 14;
/** FYI items: the Important bucket's window (L12). */
export const FYI_WINDOW_DAYS = 7;
/** A reply-needed thread that has waited this long is important on its own. */
export const AGEING_DAYS = 3;
/** Commitments more than this overdue are expired by the pass, not shown. */
export const COMMITMENT_OVERDUE_MAX_DAYS = 30;
/** Satisfaction: scores at or below this are unhappy (the scorer's 30-55 band and below). */
export const SATISFACTION_LOW_SCORE = 55;
/** Satisfaction: at or below this, hostile. */
export const SATISFACTION_HOSTILE_SCORE = 25;
/** Satisfaction items look at this many days of inbound scores. */
export const SATISFACTION_WINDOW_DAYS = 7;
/** A client's scores are fresh when its newest scored inbound row is at most this old (L13). */
export const SATISFACTION_FRESH_DAYS = 3;
/** A health drop is an item for this long, while the label stays down (L13). */
export const HEALTH_DROP_WINDOW_DAYS = 7;

const TITLE_SUBJECT_CHARS = 120;

const ESCALATION_SIGNALS: ReadonlySet<ClientSignal> = new Set<ClientSignal>([
  "complaint",
  "churn_risk",
  "outage_or_breakage",
  "billing_or_legal_dispute"
]);

const SIGNAL_LABEL: Readonly<Record<ClientSignal, string>> = Object.freeze({
  none: "no particular signal",
  complaint: "a complaint",
  churn_risk: "a churn risk",
  outage_or_breakage: "something broken or down",
  billing_or_legal_dispute: "a billing or legal dispute",
  praise: "praise"
});

// Overlaid states where no reply has gone out and nothing is lined up.
const FYI_ANSWERED: ReadonlySet<AnsweredState> = new Set<AnsweredState>(["awaiting_reply", "reply_scheduled", "draft_pending"]);

const HEALTH_RANK: Readonly<Record<ClientHealthLabel, number>> = Object.freeze({ thriving: 3, steady: 2, shaky: 1, at_risk: 0 });
const HEALTH_LABEL: Readonly<Record<ClientHealthLabel, string>> = Object.freeze({
  thriving: "thriving",
  steady: "steady",
  shaky: "shaky",
  at_risk: "at risk"
});

/** A health label exec recorded falling a band (the attention pass's snapshot, L13). */
export interface HealthDrop {
  clientId: string;
  /** The band before the drop. */
  from: ClientHealthLabel;
  /** The band now. */
  to: ClientHealthLabel;
  /** When exec first saw the lower band. */
  droppedAt: string;
  /** The label now is a leader's override, not the computed score. */
  overridden: boolean;
}

/** True when `to` is a worse band than `from`. */
export function isHealthDrop(from: ClientHealthLabel, to: ClientHealthLabel): boolean {
  return Object.hasOwn(HEALTH_RANK, from) && Object.hasOwn(HEALTH_RANK, to) && HEALTH_RANK[to] < HEALTH_RANK[from];
}

export type ProducerSignal = Pick<ExecEmailSignal, "messageId" | "flagged" | "removedAt" | "webLink">;

export interface EmailCandidateInput {
  /** principal.timezone: dates in facts read in his zone. */
  timezone: string;
  /** listProducerThreads: triaged rows with activity in the last 30 days. */
  threads: readonly ProducerThreadRow[];
  /** His open commitments (listCommitments). */
  commitments: readonly ExecCommitment[];
  /** Each commitment's own thread row, any state or age (listThreadScreenRows). */
  screenRows: ReadonlyMap<string, ThreadScreenRow>;
  /** The CL1 signals of the producer rows' anchor and newest inbound messages, by message id. */
  signals: ReadonlyMap<string, ProducerSignal>;
  /** DD reply artifacts by thread id (listAllReplyArtifacts). */
  artifacts: ReadonlyMap<string, ReplyArtifacts>;
  /** Screened inbound satisfaction rows (listSatisfactionSignals) and each client's newest scored row (latestScoredInboundByClient). */
  satisfaction: { rows: readonly DdSatisfactionSignal[]; latestScoredByClient: ReadonlyMap<string, string> };
  /** Health drops from exec's snapshot. */
  healthDrops: readonly HealthDrop[];
  /** The clients (listClients): names and status. */
  clients: readonly Pick<DdClient, "id" | "name" | "status">[];
  /** The strict, applicable restricted-sender rules and their hash H, loaded by this pass. */
  rules: readonly RestrictedSenderRule[];
  currentPolicyHash: string;
  now: Date;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Ctx {
  input: EmailCandidateInput;
  nowMs: number;
  clients: ReadonlyMap<string, Pick<DdClient, "id" | "name" | "status">>;
  subjects: ReadonlyMap<string, string>;
}

const ms = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Days (fractional, never negative) from `iso` to now; null when unreadable. */
function ageDays(ctx: Ctx, iso: string | null | undefined): number | null {
  const t = ms(iso);
  return t === null ? null : Math.max(0, (ctx.nowMs - t) / DAY_MS);
}

const within = (age: number | null, max: number) => age !== null && age <= max;
const wholeDays = (age: number | null) => (age === null ? undefined : Math.floor(age));

function span(age: number | null): string {
  if (age === null) return "an unknown time";
  const d = Math.floor(age);
  return d === 0 ? "less than a day" : pluralize(d, "day");
}

function day(ctx: Ctx, iso: string | null): string {
  return formatInZone(iso, ctx.input.timezone, "date", ctx.input.now);
}

function moment(ctx: Ctx, iso: string | null): string {
  return formatInZone(iso, ctx.input.timezone, "datetime", ctx.input.now);
}

/** A canonical ISO for a stored timestamp, so "Z" and "+00:00" spellings hash alike. */
function canonicalIso(iso: string | null | undefined): string | null {
  const t = ms(iso);
  return t === null ? null : new Date(t).toISOString();
}

function stateHash(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

// Clipped here to what attention.ts stores, so a candidate already reads the
// way its row will (the AI summary can be longer than a fact line).
function fact(text: string, basis: FactBasis, refs: SourceRef[] = []): AttentionFact {
  return { text: clipExcerpt(text, ATTENTION_LIMITS.factText), basis, refs };
}

// attention.ts refuses a whole batch over one ref whose id isn't clean, so a
// client ref is only built for an id that is (DD client ids always are).
const cleanId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512 && clipExcerpt(id, 512) === id;

function clientRef(ctx: Ctx, clientId: string | null, fallbackName: string | null): SourceRef | null {
  if (!cleanId(clientId)) return null;
  return ddClientRef({ id: clientId, name: ctx.clients.get(clientId)?.name ?? fallbackName });
}

function subjectOf(row: Pick<ProducerThreadRow, "subject">): string {
  return clipExcerpt(row.subject ?? "", TITLE_SUBJECT_CHARS) || "(no subject)";
}

interface Spec {
  fingerprint: string;
  kind: AttentionKind;
  category: AttentionCategory;
  title: string;
  whatHappened: string;
  whyItMatters: string;
  recommendedNext: string;
  facts: AttentionFact[];
  refs: (SourceRef | null)[];
  factors: Omit<PriorityFactors, "kind">;
  state: readonly unknown[];
  occurredAt: string | null;
}

function candidate(spec: Spec): AttentionCandidate {
  const seen = new Set<string>();
  const refs = spec.refs.filter((r): r is SourceRef => {
    if (r === null) return false;
    const key = `${r.system}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    fingerprint: spec.fingerprint,
    source: "email",
    kind: spec.kind,
    category: spec.category,
    title: clipExcerpt(spec.title, ATTENTION_LIMITS.title),
    whatHappened: spec.whatHappened,
    whyItMatters: spec.whyItMatters,
    recommendedNext: spec.recommendedNext,
    facts: spec.facts.slice(0, ATTENTION_LIMITS.facts),
    refs: refs.slice(0, ATTENTION_LIMITS.refs),
    priority: scorePriority({ ...spec.factors, kind: spec.kind }),
    stateHash: stateHash(spec.state),
    occurredAt: spec.occurredAt
  };
}

// ---------------------------------------------------------------------------
// Thread items: client_escalation > decision_ask > important_email
// ---------------------------------------------------------------------------

type ThreadKind = { kind: "client_escalation" | "decision_ask"; category: AttentionCategory } | { kind: "important_email"; category: "my_action" | "fyi" };

interface ThreadView {
  row: ProducerThreadRow;
  anchorId: string;
  answered: AnsweredState | null;
  awaiting: boolean;
  flagged: boolean;
  inboundAge: number | null;
  clientMatched: boolean;
  urgent: boolean;
  escalation: boolean;
  decision: boolean;
}

function threadKind(v: ThreadView): ThreadKind | null {
  const { row } = v;
  if (v.clientMatched && v.awaiting && within(v.inboundAge, ESCALATION_WINDOW_DAYS) && (v.escalation || v.urgent)) {
    return { kind: "client_escalation", category: "intervene" };
  }
  if (v.decision && v.awaiting && within(v.inboundAge, REPLY_WINDOW_DAYS)) return { kind: "decision_ask", category: "approval" };
  if (
    row.needsReply === true &&
    v.awaiting &&
    within(v.inboundAge, REPLY_WINDOW_DAYS) &&
    (v.urgent ||
      row.importance === "high" ||
      v.flagged ||
      v.clientMatched ||
      row.mitchellPersonally === true ||
      (v.inboundAge !== null && v.inboundAge >= AGEING_DAYS))
  ) {
    return { kind: "important_email", category: "my_action" };
  }
  if (
    row.needsReply !== true &&
    row.automated !== true &&
    v.answered !== null &&
    FYI_ANSWERED.has(v.answered) &&
    within(v.inboundAge, FYI_WINDOW_DAYS) &&
    (row.importance === "high" || v.flagged)
  ) {
    return { kind: "important_email", category: "fyi" };
  }
  return null;
}

function threadFacts(ctx: Ctx, v: ThreadView, k: ThreadKind): AttentionFact[] {
  const { row } = v;
  const facts: AttentionFact[] = [];
  // §0 + A7: facts may carry the AI summary and reason; the decision question
  // goes only in whyItMatters.
  if (row.summary) facts.push(fact(`Summary (AI): ${row.summary}`, "ai"));
  if (row.reason) facts.push(fact(`Why it was flagged (AI): ${row.reason}`, "ai"));
  if (k.kind === "decision_ask") facts.push(fact("Asks you for a decision (AI-assessed)", "ai"));
  if (row.urgency || row.importance) {
    facts.push(fact(`Urgency ${row.urgency ?? "unknown"}, importance ${row.importance ?? "unknown"} (AI-assessed)`, "ai"));
  }
  if (row.clientSignal && ESCALATION_SIGNALS.has(row.clientSignal)) facts.push(fact(`Client signal (AI): ${SIGNAL_LABEL[row.clientSignal]}`, "ai"));
  if (row.injectionSuspected) {
    facts.push(fact("The assistant saw what looks like instructions planted in this email; read the AI fields with care (AI)", "ai"));
  }
  if (row.clientId && row.matchConfidence) {
    const how = row.clientMatchVia === "exact" ? "a listed contact" : "the client's website domain";
    const more = row.clientCandidates > 1 ? `, one of ${row.clientCandidates} possible clients` : "";
    const name = ctx.clients.get(row.clientId)?.name ?? row.clientName ?? "a client";
    facts.push(fact(`Client: ${name} (${row.matchConfidence} confidence, matched on ${how}${more})`, "derived", [clientRef(ctx, row.clientId, row.clientName)].filter((r): r is SourceRef => r !== null)));
  }
  if (v.awaiting) facts.push(fact(`Unanswered for ${span(v.inboundAge)}`, "derived"));
  else if (v.answered === "reply_scheduled") facts.push(fact("A reply is scheduled in DD", "derived"));
  else if (v.answered === "draft_pending") facts.push(fact("A reply draft is waiting for approval in DD", "derived"));
  if (v.flagged) facts.push(fact("Flagged in Outlook", "record"));
  if (row.lastInboundAt) facts.push(fact(`Last email in: ${moment(ctx, row.lastInboundAt)}`, "record"));
  if (k.kind === "important_email" && k.category === "fyi") facts.push(fact("No reply looks needed (AI-assessed)", "ai"));
  return facts;
}

/** L4: a thread item's anchor: the newest inbound message, else the newest message (an outbound-only thread). */
export function emailThreadAnchor(row: Pick<ProducerThreadRow, "newestInboundMessageId" | "newestMessageId">): string | null {
  return row.newestInboundMessageId ?? row.newestMessageId ?? null;
}

function threadCandidate(ctx: Ctx, row: ProducerThreadRow): AttentionCandidate | null {
  const { input } = ctx;
  // A2: the screen comes before anything is read off the row.
  if (screenStoredRow(row, input.rules, input.currentPolicyHash).verdict === "restricted") return null;
  if (row.state !== "triaged") return null;
  const anchorId = emailThreadAnchor(row);
  if (!anchorId) return null;
  const fingerprint = emailThreadFingerprint(row.threadId, anchorId);
  if (fingerprint === null) return null;

  const inboundSignal = row.newestInboundMessageId ? input.signals.get(row.newestInboundMessageId) : undefined;
  const answered = overlayAnswered(row, inboundSignal, input.artifacts.get(row.threadId));
  const view: ThreadView = {
    row,
    anchorId,
    answered,
    awaiting: answered === "awaiting_reply",
    flagged: input.signals.get(anchorId)?.flagged === true,
    inboundAge: ageDays(ctx, row.lastInboundAt),
    clientMatched: row.clientId !== null && (row.matchConfidence === "high" || row.matchConfidence === "medium"),
    urgent: row.urgency === "critical" || row.urgency === "high",
    escalation: row.clientSignal !== null && ESCALATION_SIGNALS.has(row.clientSignal),
    decision: typeof row.decisionQuestion === "string" && row.decisionQuestion.trim() !== ""
  };
  const k = threadKind(view);
  if (k === null) return null;

  const subject = subjectOf(row);
  const clientName = (row.clientId ? ctx.clients.get(row.clientId)?.name : null) ?? row.clientName ?? "A client";
  const ago = `${span(view.inboundAge)} ago`;
  const webLink = (row.newestInboundMessageId ? input.signals.get(row.newestInboundMessageId)?.webLink : null) ?? input.signals.get(row.newestMessageId ?? "")?.webLink ?? null;
  const urgencyText = row.urgency === "critical" || row.urgency === "high" ? `${row.urgency} urgency` : null;

  let title: string;
  let whatHappened: string;
  let whyItMatters: string;
  let recommendedNext: string;
  switch (k.kind) {
    case "client_escalation":
      title = `Client escalation from ${clipExcerpt(clientName, 60)}: ${subject}`;
      whatHappened = `${clientName} wrote ${ago}, and it hasn't been answered.`;
      whyItMatters = `AI-assessed as ${view.escalation && row.clientSignal ? SIGNAL_LABEL[row.clientSignal] : urgencyText ?? "urgent"} from a client.`;
      recommendedNext = "Reply today, or hand it to the client's account lead with a deadline.";
      break;
    case "decision_ask":
      title = `Decision needed: ${subject}`;
      whatHappened = `A decision was asked of you ${ago}, and it hasn't been answered.`;
      // The question is the model's clipped reading of the email (≤200), labeled as such.
      whyItMatters = `AI-assessed: the email asks you to decide${row.decisionQuestion ? `: ${clipExcerpt(row.decisionQuestion, 200)}` : " something"}`;
      recommendedNext = "Make the call and reply, or say when you will decide.";
      break;
    case "important_email":
      if (k.category === "my_action") {
        title = `Reply needed: ${subject}`;
        whatHappened = `An email came in ${ago}, and it hasn't been answered.${view.flagged ? " You flagged it in Outlook." : ""}`;
        whyItMatters = urgencyText
          ? `AI-assessed as ${urgencyText} and needing your reply.`
          : view.clientMatched
            ? "AI-assessed as needing your reply, and it is from a client."
            : "AI-assessed as needing your reply.";
        recommendedNext = "Reply, or delegate it with a clear deadline.";
      } else {
        title = `Important email: ${subject}`;
        whatHappened = `An email came in ${ago}.${view.flagged ? " You flagged it in Outlook." : ""}`;
        whyItMatters = row.importance === "high" ? "AI-assessed as important, though no reply looks needed." : "You flagged it in Outlook.";
        recommendedNext = "Read it when you have a moment; no reply looks needed.";
      }
      break;
  }

  const factors: Omit<PriorityFactors, "kind"> = {
    ageDays: wholeDays(view.inboundAge),
    urgency: row.urgency ?? undefined,
    flagged: view.flagged,
    clientFacing: k.kind !== "client_escalation" && view.clientMatched
  };
  return candidate({
    fingerprint,
    kind: k.kind,
    category: k.category,
    title,
    whatHappened,
    whyItMatters,
    recommendedNext,
    facts: threadFacts(ctx, view, k),
    refs: [
      execEmailThreadRef(row.threadId, row.subject),
      webLink ? execEmailRef({ threadId: row.threadId, webLink, label: row.subject }) : null,
      view.clientMatched || row.clientId ? clientRef(ctx, row.clientId, row.clientName) : null
    ],
    factors,
    // L4 / §3.13: no time inputs. The kind is in it, so a kind change reopens a seen item.
    state: [
      "email-thread-v1",
      k.kind,
      k.category,
      anchorId,
      answered,
      row.urgency,
      row.importance,
      row.clientSignal,
      view.decision,
      row.decisionMessageId,
      view.flagged
    ],
    occurredAt: row.lastInboundAt
  });
}

// ---------------------------------------------------------------------------
// overdue_commitment
// ---------------------------------------------------------------------------

function overdueBucket(days: number): string {
  if (days >= 14) return "14-30";
  if (days >= 7) return "7-13";
  if (days >= 3) return "3-6";
  return "0-2";
}

/** A commitment's thread row passes the A2 screen: it exists, isn't a tombstone or gone, and is clean under H. */
function commitmentThreadVisible(ctx: Ctx, threadId: string): boolean {
  const row = ctx.input.screenRows.get(threadId);
  if (!row || row.state === "restricted_hidden" || row.state === "gone") return false;
  return screenStoredRow(row, ctx.input.rules, ctx.input.currentPolicyHash).verdict === "clean";
}

function commitmentCandidate(ctx: Ctx, c: ExecCommitment): AttentionCandidate | null {
  if (c.status !== "open") return null;
  if (!commitmentThreadVisible(ctx, c.threadId)) return null;
  const due = ms(c.dueAt);
  if (due === null) return null;
  const overdueMs = ctx.nowMs - due;
  if (overdueMs <= 0 || overdueMs > COMMITMENT_OVERDUE_MAX_DAYS * DAY_MS) return null;
  const fingerprint = emailCommitmentFingerprint(c.threadId, c.id);
  if (fingerprint === null) return null;

  const days = Math.floor(overdueMs / DAY_MS);
  const late = days === 0 ? "less than a day" : pluralize(days, "day");
  const dueDay = day(ctx, c.dueAt);
  const owes = c.direction === "mitchell_owes";
  const subject = ctx.subjects.get(c.threadId) ?? null;
  const facts: AttentionFact[] = [
    fact(`Commitment (AI-extracted): ${c.text}`, "ai"),
    fact(`Due ${dueDay}${c.dueText ? ` (the email said "${c.dueText}")` : ""} (AI-read)`, "ai"),
    fact(`${late} overdue`, "derived"),
    fact(`From an email of ${day(ctx, c.messageSentAt)}`, "record")
  ];
  if (c.counterparty) facts.splice(1, 0, fact(`${owes ? "Owed to" : "Owed by"} (AI): ${c.counterparty}`, "ai"));
  return candidate({
    fingerprint,
    kind: "overdue_commitment",
    category: owes ? "my_action" : "delegated",
    title: owes ? `You promised: ${c.text}` : `Owed to you: ${c.text}`,
    whatHappened: owes
      ? `You committed to deliver this${c.counterparty ? ` to ${c.counterparty}` : ""} by ${dueDay}. It is ${late} overdue.`
      : `${c.counterparty ?? "Someone"} committed to deliver this to you by ${dueDay}. It is ${late} overdue.`,
    whyItMatters: owes
      ? "AI-extracted from your email: a promise you made is past its date, and the other side may be waiting."
      : "AI-extracted from your email: something owed to you is late and may need a nudge.",
    recommendedNext: owes ? "Deliver it, or send a new date." : "Follow up and ask for a new date.",
    facts,
    refs: [execEmailThreadRef(c.threadId, subject ?? "Email thread")],
    factors: { overdueDays: days },
    state: ["email-commitment-v1", c.status, canonicalIso(c.dueAt), overdueBucket(days), c.direction],
    occurredAt: c.dueAt
  });
}

// ---------------------------------------------------------------------------
// client_satisfaction_drop (L13)
// ---------------------------------------------------------------------------

function satisfactionCandidates(ctx: Ctx): AttentionCandidate[] {
  const { input } = ctx;
  const windowStart = ctx.nowMs - SATISFACTION_WINDOW_DAYS * DAY_MS;
  const low = new Map<string, DdSatisfactionSignal[]>();
  for (const r of input.satisfaction.rows) {
    const at = ms(r.deliveredAt);
    if (at === null || at < windowStart || !(r.score <= SATISFACTION_LOW_SCORE)) continue;
    low.set(r.clientId, [...(low.get(r.clientId) ?? []), r]);
  }
  const out: AttentionCandidate[] = [];
  for (const [clientId, rows] of [...low].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const client = ctx.clients.get(clientId);
    if (!client || !isActiveClientStatus(client.status)) continue;
    // Per-client freshness: stale scores say nothing about how the client feels now.
    const scored = ms(input.satisfaction.latestScoredByClient.get(clientId));
    if (scored === null || ctx.nowMs - scored > SATISFACTION_FRESH_DAYS * DAY_MS) continue;
    const fingerprint = emailClientFingerprint("satisfaction", clientId);
    const ref = clientRef(ctx, clientId, client.name);
    if (fingerprint === null || ref === null) continue;

    const lowest = rows.reduce((min, r) => (r.score < min.score ? r : min));
    const newest = rows.reduce((max, r) => ((ms(r.deliveredAt) ?? 0) > (ms(max.deliveredAt) ?? 0) ? r : max));
    const hostile = lowest.score <= SATISFACTION_HOSTILE_SCORE;
    const count = pluralize(rows.length, "inbound email");
    out.push(
      candidate({
        fingerprint,
        kind: "client_satisfaction_drop",
        category: "intervene",
        title: `Client satisfaction dropped: ${client.name}`,
        whatHappened: `${count} from ${client.name} in the last ${SATISFACTION_WINDOW_DAYS} days scored ${hostile ? "as hostile" : "as unhappy"}.`,
        whyItMatters: "AI-assessed: low satisfaction often comes before a complaint or a cancellation.",
        recommendedNext: "Look over the client's recent mail, and check in with them or their account lead.",
        facts: [
          fact(`Lowest score ${lowest.score}/100, on mail of ${day(ctx, lowest.deliveredAt)} (AI-scored)`, "ai"),
          fact(`${count} at or below ${SATISFACTION_LOW_SCORE}/100 in the last ${SATISFACTION_WINDOW_DAYS} days (AI-scored)`, "ai"),
          fact(`Scores current as of ${moment(ctx, input.satisfaction.latestScoredByClient.get(clientId) ?? null)}`, "record", [ref])
        ],
        refs: [ref],
        factors: { count: rows.length, severity: hostile ? "high" : "medium" },
        state: ["email-satisfaction-v1", rows.length, canonicalIso(newest.deliveredAt), hostile ? "hostile" : "unhappy"],
        occurredAt: newest.deliveredAt
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// client_health_drop (L13)
// ---------------------------------------------------------------------------

function healthCandidates(ctx: Ctx): AttentionCandidate[] {
  const out: AttentionCandidate[] = [];
  const seen = new Set<string>();
  for (const d of [...ctx.input.healthDrops].sort((a, b) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0))) {
    if (seen.has(d.clientId) || !isHealthDrop(d.from, d.to)) continue;
    seen.add(d.clientId);
    const at = ms(d.droppedAt);
    if (at === null || ctx.nowMs - at > HEALTH_DROP_WINDOW_DAYS * DAY_MS) continue;
    const client = ctx.clients.get(d.clientId);
    if (!client || !isActiveClientStatus(client.status)) continue;
    const fingerprint = emailClientFingerprint("health", d.clientId);
    const ref = clientRef(ctx, d.clientId, client.name);
    if (fingerprint === null || ref === null) continue;
    const from = HEALTH_LABEL[d.from];
    const to = HEALTH_LABEL[d.to];
    out.push(
      candidate({
        fingerprint,
        kind: "client_health_drop",
        category: "intervene",
        title: `Client health dropped: ${client.name}`,
        whatHappened: `${client.name}'s health went from ${from} to ${to} on ${day(ctx, d.droppedAt)}.`,
        whyItMatters: d.overridden
          ? "A leader marked this client down."
          : "DD's client-health label fell; it is built from the AI scoring of the client's recent email.",
        recommendedNext: "Ask the client's account lead what changed.",
        facts: [
          fact(`Health now: ${to}${d.overridden ? " (set by a leader)" : ""}`, "record", [ref]),
          fact(`Was ${from} until ${day(ctx, d.droppedAt)}`, "derived")
        ],
        refs: [ref],
        factors: { severity: d.to === "at_risk" ? "high" : d.to === "shaky" ? "medium" : "low" },
        state: ["email-health-v1", d.from, d.to, canonicalIso(d.droppedAt)],
        occurredAt: d.droppedAt
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * The email Needs Attention candidates for one pass (pure). Every thread row
 * and every commitment's thread row is screened first (A2); a row that fails
 * makes nothing. At most one candidate per fingerprint: a duplicate input row
 * is ignored rather than failing the sync.
 */
export function buildEmailCandidates(input: EmailCandidateInput): AttentionCandidate[] {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("buildEmailCandidates: now must be a valid Date");
  const clients = new Map(input.clients.filter((c) => typeof c?.id === "string").map((c) => [c.id, c]));
  const subjects = new Map<string, string>();
  for (const row of input.threads) {
    // A row that fails the screen lends nothing, not even its subject as a commitment's link label.
    if (row.subject && screenStoredRow(row, input.rules, input.currentPolicyHash).verdict === "clean") subjects.set(row.threadId, row.subject);
  }
  const ctx: Ctx = { input, nowMs, clients, subjects };

  const out: AttentionCandidate[] = [];
  const fingerprints = new Set<string>();
  const add = (c: AttentionCandidate | null) => {
    if (c === null || fingerprints.has(c.fingerprint)) return;
    fingerprints.add(c.fingerprint);
    out.push(c);
  };
  for (const row of input.threads) add(threadCandidate(ctx, row));
  for (const c of input.commitments) add(commitmentCandidate(ctx, c));
  for (const c of satisfactionCandidates(ctx)) add(c);
  for (const c of healthCandidates(ctx)) add(c);
  return out;
}
