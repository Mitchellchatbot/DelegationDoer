import type { PriorityBand, PriorityResult } from "@/lib/exec/attention-types";
import type { TaskPriority } from "@/lib/exec/sources/dd-types";
import { NonRetryableError } from "@/lib/exec/types";

// Deterministic priority for Needs Attention items (pure, no I/O).
//
// Every producer scores its candidates here, so a 70 means the same thing for
// an overdue task group as for an approval queue, and the feed can sort them
// against each other. A score is a base per kind plus fixed additions for the
// factors the producer knows (how overdue, how old, how many, task priority,
// client-facing, about the executive himself, severity), clamped to 0..100.
// The reasons spell out every contribution, so the band shown on an item can
// always be traced back to plain facts. The scoring itself involves no model:
// an AI-assessed input (an email's urgency, P3) is just a factor, named as
// such in its reason, so the item says where its band came from.

export type AttentionKind =
  | "unanswered_mention"
  | "open_incident"
  | "site_alert"
  | "pending_approval"
  | "overdue_tasks"
  | "stalled_tasks"
  | "waiting_on_client"
  | "recurring_issue"
  | "missed_deadlines"
  // Email intelligence (P3, producers/email.ts).
  | "important_email"
  | "client_escalation"
  | "decision_ask"
  | "overdue_commitment"
  | "client_satisfaction_drop"
  | "client_health_drop"
  // DD text triage (P5a, producers/ddtext.ts). The first three are a model's
  // reading of DD text; a mention is found by code.
  | "ddtext_blocker"
  | "ddtext_waiting"
  | "ddtext_decision"
  | "ddtext_mention"
  // Slack reading (P7a, producers/slack.ts; contract §3.13, C19). Stage -1 seed:
  // the kinds, bases and labels; the Slack age lines in ageContribution are Area D's.
  | "slack_decision"
  | "slack_request"
  | "slack_commitment"
  | "slack_unassessed";

/** An email's urgency as triage assessed it (email-types Urgency). */
export type UrgencyFactor = "critical" | "high" | "normal" | "low";

export interface PriorityFactors {
  kind: AttentionKind;
  /** Whole days past due (of the oldest item, for a group). */
  overdueDays?: number;
  /** Whole days the situation has been waiting. Counts only for mentions, approvals, waiting-on-client and the email thread kinds. */
  ageDays?: number;
  /** Items in a grouped situation. */
  count?: number;
  taskPriority?: TaskPriority;
  clientFacing?: boolean;
  /** The item is about the executive himself (he was mentioned, he owns it). */
  aboutPrincipal?: boolean;
  severity?: "low" | "medium" | "high";
  /** The AI-assessed urgency of an email (P3). */
  urgency?: UrgencyFactor;
  /** He flagged the email in Outlook (a stored CL1 signal, P3). */
  flagged?: boolean;
}

const BASE: Readonly<Record<AttentionKind, number>> = Object.freeze({
  open_incident: 45,
  unanswered_mention: 40,
  overdue_tasks: 25,
  site_alert: 25,
  recurring_issue: 25,
  pending_approval: 20,
  stalled_tasks: 12,
  waiting_on_client: 10,
  missed_deadlines: 8,
  client_escalation: 45,
  decision_ask: 35,
  client_health_drop: 35,
  important_email: 30,
  overdue_commitment: 30,
  client_satisfaction_drop: 30,
  ddtext_blocker: 60,
  ddtext_decision: 55,
  ddtext_mention: 50,
  ddtext_waiting: 45,
  slack_decision: 45,
  slack_request: 40,
  slack_commitment: 30,
  slack_unassessed: 40
});

const KIND_LABEL: Readonly<Record<AttentionKind, string>> = Object.freeze({
  open_incident: "Open incident",
  unanswered_mention: "Unanswered mention",
  overdue_tasks: "Overdue tasks",
  site_alert: "Site alert",
  recurring_issue: "Recurring issue",
  pending_approval: "Pending approval",
  stalled_tasks: "Stalled tasks",
  waiting_on_client: "Waiting on client",
  missed_deadlines: "Missed deadlines",
  client_escalation: "Client escalation",
  decision_ask: "Decision asked of you",
  client_health_drop: "Client health drop",
  important_email: "Important email",
  overdue_commitment: "Overdue commitment",
  client_satisfaction_drop: "Client satisfaction drop",
  ddtext_blocker: "Blocker in DD text (AI-assessed)",
  ddtext_waiting: "Waiting in DD text (AI-assessed)",
  ddtext_decision: "Decision asked in DD text (AI-assessed)",
  ddtext_mention: "Mention of you in a comment",
  slack_decision: "Decision asked of you in Slack",
  slack_request: "Slack message to you",
  slack_commitment: "Slack commitment",
  slack_unassessed: "Slack message (not assessed)"
});

interface Contribution {
  text: string;
  points: number;
}

const TASK_PRIORITY: Readonly<Record<TaskPriority, Contribution>> = Object.freeze({
  critical: { text: "Critical task priority", points: 25 },
  high: { text: "High task priority", points: 12 },
  medium: { text: "Medium task priority", points: 0 },
  low: { text: "Low task priority", points: -5 }
});

const SEVERITY: Readonly<Record<NonNullable<PriorityFactors["severity"]>, Contribution>> = Object.freeze({
  high: { text: "High severity", points: 20 },
  medium: { text: "Medium severity", points: 8 },
  low: { text: "Low severity", points: 0 }
});

// The reason names the basis: the urgency is the model's call, not a record.
const URGENCY: Readonly<Record<UrgencyFactor, Contribution>> = Object.freeze({
  critical: { text: "Critical urgency (AI-assessed)", points: 25 },
  high: { text: "High urgency (AI-assessed)", points: 12 },
  normal: { text: "Normal urgency (AI-assessed)", points: 0 },
  low: { text: "Low urgency (AI-assessed)", points: 0 }
});

const FLAGGED: Contribution = Object.freeze({ text: "Flagged in Outlook", points: 8 });

const CRITICAL_AT = 75;
const HIGH_AT = 50;

// The typographic minus, so a negative reads "(−5)" like the positive "(+12)".
const MINUS = "−";

/** Whole days (or items) for a factor: floored, and 0 for anything negative or not a finite number. */
function whole(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** The age addition, which depends on the kind: only waiting matters for these. None for the ddtext kinds (C17). */
function ageContribution(kind: AttentionKind, ageDays: number): Contribution | null {
  switch (kind) {
    case "unanswered_mention":
      return { text: `Unanswered for ${days(ageDays)}`, points: Math.min(20, 2 * ageDays) };
    case "pending_approval":
      return { text: `Waiting ${days(ageDays)} for approval`, points: Math.min(15, ageDays) };
    case "waiting_on_client":
      // A week of waiting on a client is normal; only the time past that counts.
      return { text: `Waiting on the client for ${days(ageDays)}`, points: Math.min(15, Math.max(0, ageDays - 7)) };
    case "important_email":
      return { text: `Waiting ${days(ageDays)}`, points: Math.min(15, 2 * ageDays) };
    case "decision_ask":
      return { text: `Decision waiting ${days(ageDays)}`, points: Math.min(15, 2 * ageDays) };
    case "client_escalation":
      // An unhappy client gets angrier faster than an ordinary email ages.
      return { text: `Client waiting ${days(ageDays)}`, points: Math.min(15, 3 * ageDays) };
    // Slack reading (P7a contract §3.13, C19). For a commitment the producer passes the days overdue as ageDays.
    case "slack_decision":
      return { text: `Decision waiting ${days(ageDays)}`, points: Math.min(15, 2 * ageDays) };
    case "slack_request":
    case "slack_unassessed":
      return { text: `Unanswered for ${days(ageDays)}`, points: Math.min(20, 2 * ageDays) };
    case "slack_commitment":
      return { text: `Follow-up overdue ${days(ageDays)}`, points: Math.min(15, 2 * ageDays) };
    default:
      return null;
  }
}

/** The band for a score: critical at 75 and up, high at 50 and up, normal below. */
function bandFor(score: number): PriorityBand {
  if (score >= CRITICAL_AT) return "critical";
  if (score >= HIGH_AT) return "high";
  return "normal";
}

/**
 * Score a situation. Returns the clamped integer score (0..100), its band and
 * the reasons: the base first, then every non-zero contribution, largest
 * first ("Overdue 14 days (+28)", "Low task priority (−5)").
 */
export function scorePriority(f: PriorityFactors): PriorityResult {
  const base = Object.hasOwn(BASE, f.kind) ? BASE[f.kind] : undefined;
  if (base === undefined) throw new NonRetryableError(`scorePriority: unknown kind ${JSON.stringify(f.kind)}`);

  // In the order of the contract's table; equal contributions keep this order.
  const parts: Contribution[] = [];
  const overdue = whole(f.overdueDays);
  if (overdue > 0) parts.push({ text: `Overdue ${days(overdue)}`, points: Math.min(30, 2 * overdue) });
  const age = ageContribution(f.kind, whole(f.ageDays));
  if (age) parts.push(age);
  const count = whole(f.count);
  // The first item is what the base already scores; each one after it adds.
  if (count > 1) parts.push({ text: `${count} items`, points: Math.min(15, 3 * (count - 1)) });
  if (f.taskPriority && Object.hasOwn(TASK_PRIORITY, f.taskPriority)) parts.push(TASK_PRIORITY[f.taskPriority]);
  if (f.clientFacing === true) parts.push({ text: "Client-facing", points: 8 });
  if (f.aboutPrincipal === true) parts.push({ text: "Involves you", points: 10 });
  if (f.severity && Object.hasOwn(SEVERITY, f.severity)) parts.push(SEVERITY[f.severity]);
  if (f.urgency && Object.hasOwn(URGENCY, f.urgency)) parts.push(URGENCY[f.urgency]);
  if (f.flagged === true) parts.push(FLAGGED);

  const contributing = parts.filter((p) => p.points !== 0);
  const raw = contributing.reduce((sum, p) => sum + p.points, base);
  const score = Math.min(100, Math.max(0, Math.round(raw)));
  // Array.prototype.sort is stable, so ties stay in table order.
  const reasons = [
    `${KIND_LABEL[f.kind]} (base ${base})`,
    ...contributing
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
      .map((p) => `${p.text} (${p.points > 0 ? "+" : MINUS}${Math.abs(p.points)})`)
  ];
  return { score, band: bandFor(score), reasons };
}
