import type { FactBasis } from "@/lib/exec/attention-types";
import type {
  AnsweredState,
  ClientMatchVia,
  ClientSignal,
  CommitmentDirection,
  EmailBucket,
  EmailCategory,
  EmailThreadState,
  FilterReason,
  LastAttemptError,
  MatchConfidence,
  TriageError,
  Urgency
} from "@/lib/exec/email-types";

// Words for the email surfaces (Email tab, thread page, Overview card). Pure
// data: every label a stored enum can take, so the page never shows a raw
// code, and an unknown code is shown as itself rather than dressed up.

/** The bucket order on the page (the same as email-view's EMAIL_BUCKETS). */
export const BUCKET_ORDER: readonly EmailBucket[] = Object.freeze(["reply", "urgent", "important", "waiting", "filtered"]);

export interface BucketMeta {
  label: string;
  /** The short name on its tab. */
  tab: string;
  /** The rule that puts a thread here, in his words (L12). */
  rule: string;
  /** What decides membership: the AI's reading, or a fixed rule over records. */
  basis: FactBasis;
  /** Shown when the bucket is empty (the read worked). */
  empty: string;
}

export const BUCKET_META: Readonly<Record<EmailBucket, BucketMeta>> = Object.freeze({
  reply: {
    label: "Needs your reply",
    tab: "Needs reply",
    rule: "The assistant read it as needing your reply, and none has gone out. Last 30 days.",
    basis: "ai",
    empty: "Nothing is waiting on your reply."
  },
  urgent: {
    label: "Urgent",
    tab: "Urgent",
    rule: "Read as critical or high urgency, and still waiting on your reply. Last 14 days.",
    basis: "ai",
    empty: "Nothing urgent is waiting on you."
  },
  important: {
    label: "Important",
    tab: "Important",
    rule: "Read as high importance, or flagged in Outlook. Last 7 days.",
    basis: "ai",
    empty: "Nothing marked important in the last 7 days."
  },
  waiting: {
    label: "Waiting on others",
    tab: "Waiting",
    rule: "You wrote last, 2 to 30 days ago, and the assistant expects a reply to it.",
    basis: "ai",
    empty: "No one owes you a reply."
  },
  filtered: {
    label: "Filtered / not assessed",
    tab: "Not assessed",
    rule: "Set aside as automated or unanswerable, or the assessment failed or was deferred. Last 7 days. Assess runs it now.",
    basis: "derived",
    empty: "Nothing was filtered or left unassessed in the last 7 days."
  }
});

/**
 * When a bucket's list is empty but the assistant may not have read all of
 * his mail yet (ui-5): before the first sync or while it catches up the
 * empty list is an unknown, not a fact; when the mail status couldn't be
 * read, it says it may be incomplete.
 */
export const EMPTY_WHILE_CATCHING_UP = "Nothing here yet — the assistant hasn't finished reading your mail.";
export const EMPTY_STATUS_UNKNOWN = "Nothing here, but the mail status couldn't be checked, so this may be incomplete.";

/** Over the AI fields of a thread whose newest mail wasn't assessed: they come from an earlier assessment (ui-6). */
export const EARLIER_ASSESSMENT = "Earlier assessment (before the newest message)";

/**
 * The stored answered states as plain facts (derived from his mailbox). An
 * unanswered newest inbound message is "No reply yet": only the assistant's
 * reading says whether a reply is needed (answeredLabel).
 */
export const ANSWERED_LABEL: Readonly<Record<AnsweredState, string>> = Object.freeze({
  awaiting_reply: "No reply yet",
  answered: "You replied",
  no_inbound: "Only your messages",
  handled_in_outlook: "Archived in Outlook",
  reply_scheduled: "Reply scheduled",
  draft_pending: "Draft awaiting approval"
});

type AnsweredRow = { answered: AnsweredState | null; state: EmailThreadState; needsReply: boolean | null };

/**
 * The answered state as words for a thread (ui-7): "Awaiting your reply" only
 * where the assistant read the thread as needing his reply; any other
 * unanswered thread is "No reply yet", never a claim that he owes one.
 */
export function answeredLabel(row: AnsweredRow): string | null {
  if (row.answered === "awaiting_reply" && row.needsReply === true) return "Awaiting your reply";
  return labelOf(ANSWERED_LABEL, row.answered);
}

/**
 * The answered chip on a list row (ui-7): as answeredLabel, but none at all on
 * an unanswered thread that was set aside (automated, nobody to reply to) or
 * read as needing no reply. There the chip would only contradict the row.
 */
export function answeredChipLabel(row: AnsweredRow): string | null {
  if (row.answered === "awaiting_reply" && (row.state === "filtered" || row.needsReply === false)) return null;
  return answeredLabel(row);
}

export const CATEGORY_LABEL: Readonly<Record<EmailCategory, string>> = Object.freeze({
  client: "Client",
  prospect: "Prospect",
  partner_vendor: "Partner or vendor",
  internal_team: "Team",
  finance_admin: "Finance or admin",
  legal: "Legal",
  recruiting: "Recruiting",
  personal: "Personal",
  newsletter_marketing: "Newsletter",
  notification: "Notification",
  calendar: "Calendar",
  other: "Other"
});

export const URGENCY_LABEL: Readonly<Record<Urgency, string>> = Object.freeze({
  critical: "Critical",
  high: "High urgency",
  normal: "Normal urgency",
  low: "Low urgency"
});

export const CLIENT_SIGNAL_LABEL: Readonly<Record<ClientSignal, string>> = Object.freeze({
  none: "No client signal",
  complaint: "Complaint",
  churn_risk: "Churn risk",
  outage_or_breakage: "Something is broken",
  billing_or_legal_dispute: "Billing or legal dispute",
  praise: "Praise"
});

export const FILTER_REASON_LABEL: Readonly<Record<FilterReason, string>> = Object.freeze({
  unreplyable: "Set aside: no one to reply to",
  automated_hint: "Set aside: looks automated"
});

export const TRIAGE_ERROR_LABEL: Readonly<Record<TriageError, string>> = Object.freeze({
  refusal: "Not assessed: the model declined",
  truncated: "Not assessed: the answer was cut off",
  invalid_output: "Not assessed: the answer was malformed",
  input_too_large: "Not assessed: too long to read"
});

export const ATTEMPT_ERROR_LABEL: Readonly<Record<LastAttemptError, string>> = Object.freeze({
  ...TRIAGE_ERROR_LABEL,
  budget: "Deferred: today's AI budget was used up"
});

export const MATCH_VIA_LABEL: Readonly<Record<ClientMatchVia, string>> = Object.freeze({
  exact: "contact email",
  domain: "domain match"
});

export const CONFIDENCE_LABEL: Readonly<Record<MatchConfidence, string>> = Object.freeze({
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence"
});

export const DIRECTION_LABEL: Readonly<Record<CommitmentDirection, string>> = Object.freeze({
  mitchell_owes: "You owe",
  owed_to_mitchell: "Owed to you"
});

/** A stored code as words, or the code itself when this build doesn't know it. */
export function labelOf<K extends string>(table: Readonly<Record<K, string>>, code: K | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : String(code);
}

/** "jane@acme.com" → "jane@acme.com"; a name → the name; neither → "Unknown sender". */
export function personLabel(name: string | null | undefined, email: string | null | undefined): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (n) return n;
  const e = typeof email === "string" ? email.trim() : "";
  return e || "Unknown sender";
}

/** "1.2 MB", "340 KB", "12 bytes", or null. */
export function sizeLabel(bytes: number | null): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const SUBJECT_FALLBACK = "(no subject)";
