import type { SourceRef } from "@/lib/exec/types";

// The Needs Attention model (plan §2 "What Mitchell sees", §5 exec_attention_items).
//
// Producers (deterministic DD rules in P2b; email triage in P3; Slack in P7)
// turn source data into AttentionCandidates. attention.ts reconciles them with
// exec_attention_items: one row per (principal, fingerprint), so the same
// situation seen on every refresh stays one item instead of piling up.
//
// Honesty rules (plan §2 rule 6): every fact says whether it is a stored
// record, something derived from records by a deterministic rule, or an AI
// assessment; recommendations are a separate field, always shown labeled as
// a suggestion, never as a fact.

export type AttentionSource = "dd" | "email" | "slack";

/**
 * What kind of response the item asks of the executive:
 *   my_action  he has to do something himself (answer a mention, reply)
 *   approval   a decision waits on approval (draft tasks, email drafts, proofs…)
 *   delegated  someone else owns it, but it is slipping (overdue, stalled)
 *   intervene  something is broken or recurring and may need him to step in
 *   fyi        worth knowing, nothing to do
 *   on_track   explicitly fine (used sparingly, e.g. a project back on track)
 */
export type AttentionCategory = "my_action" | "approval" | "delegated" | "intervene" | "fyi" | "on_track";

export type PriorityBand = "critical" | "high" | "normal";

/**
 * open      new or changed since he last looked
 * seen      he has seen it; it reopens when its state changes
 * snoozed   hidden until snooze_until
 * dismissed he said it doesn't matter; reopens only if its band escalates
 * resolved  the condition went away (auto) or he marked it done (owner)
 */
export type AttentionStatus = "open" | "seen" | "snoozed" | "dismissed" | "resolved";

/**
 * record   read straight from a stored row ("due 21 Oct, status in_progress")
 * derived  computed from records by a fixed rule ("14 days overdue")
 * ai       a model's assessment (P3+ triage); always shown as "AI-assessed"
 */
export type FactBasis = "record" | "derived" | "ai";

export interface AttentionFact {
  text: string;
  basis: FactBasis;
  refs: SourceRef[];
}

/** Deterministic priority (priority.ts): the score, its band and why. */
export interface PriorityResult {
  score: number;
  band: PriorityBand;
  /** Human-readable contributions, largest first, e.g. "Overdue 14 days (+28)". */
  reasons: string[];
}

export interface AttentionCandidate {
  /**
   * Stable identity of the situation, unique per principal. Namespaced by
   * source and rule, e.g. "dd:overdue:assignee:u_123", "dd:approval:email_drafts".
   * The same situation must produce the same fingerprint on every run.
   */
  fingerprint: string;
  source: AttentionSource;
  /** The producer rule, e.g. "overdue_tasks". attention.ts auto-resolves per (source, kind). */
  kind: string;
  category: AttentionCategory;
  /** One line, plain text. */
  title: string;
  /** What happened, plain text, from records. */
  whatHappened: string;
  /** Why it matters, plain text. */
  whyItMatters: string;
  /** A suggestion, rendered labeled ("Suggested next step"). null = none. */
  recommendedNext: string | null;
  facts: AttentionFact[];
  /** The records it is about, most relevant first (links are allowlisted by refs.ts). */
  refs: SourceRef[];
  priority: PriorityResult;
  /**
   * Changes when the underlying state changes in a way he would want to see
   * again (count, oldest age bucket, status). Not on every refresh: a hash of
   * the facts that matter, not of timestamps.
   */
  stateHash: string;
  /** When the underlying thing happened (ISO), for "age"; null if unknown. */
  occurredAt: string | null;
}

export interface AttentionItem extends AttentionCandidate {
  id: string;
  principalId: string;
  status: AttentionStatus;
  snoozeUntil: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** "auto" (the condition went away) or "owner" (he resolved it). */
  resolution: "auto" | "owner" | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// P5a (contract §3.1.1; lead seed): the feed as the owner acts on it. Nothing
// above changes.
// ---------------------------------------------------------------------------

/** An item as the feed shows it: the stored item plus the CAS token for owner actions. */
export interface AttentionFeedItem extends AttentionItem {
  /** exec_attention_items.updated_at exactly as PostgREST printed it (C3). Opaque to clients. */
  version: string;
}
export type AttentionStatusFilter = "default" | "open" | "seen" | "snoozed" | "dismissed" | "resolved";
export interface AttentionFilters {
  /** "default" (absent) = open + seen, open including snoozes that have run out (C6). */
  status?: AttentionStatusFilter;
  category?: AttentionCategory;
  band?: PriorityBand;
  source?: AttentionSource;
  /** Format-checked (/^[a-z][a-z0-9_]{0,63}$/), not enum-checked. */
  kind?: string;
  /** ISO; first_seen_at >= it (P5b "what did I miss"). */
  firstSeenAfter?: string;
  /** ISO; updated_at >= it. */
  updatedAfter?: string;
  /** From a previous page's nextCursor. */
  cursor?: string | null;
  /** 1..100, default 50. */
  limit?: number;
}
export type EmailScreenState = "none" | "ok" | "unavailable";
/** P7a (contract §3.14, C20): the Slack screen's state on a page, ranked like EmailScreenState. */
export type SlackScreenState = "none" | "ok" | "unavailable";
export interface ScreenedAttentionPage {
  items: AttentionFeedItem[];
  nextCursor: string | null;
  /** Email items withheld on this page: restricted, gone, missing or unscreenable (C7, K24). */
  hiddenEmail: number;
  /** "none": no email item was examined; "unavailable": the screen couldn't run, so every email thread/commitment item was withheld. */
  emailScreen: EmailScreenState;
  /**
   * P7a (§3.14, C20): Slack items withheld on this page (reading off, a never-read, hub or unclassified
   * conversation, a deleted message, a muted or unwatched conversation, a finance item on a Slack surface, or an
   * unscreenable batch). Optional in the type so every earlier page literal compiles; listScreenedAttention always
   * sets it.
   */
  hiddenSlack?: number;
  /** P7a: "none": no Slack item was examined; "unavailable": the Slack screen rows couldn't be read, so every Slack item was withheld. Always set by the accessor. */
  slackScreen?: SlackScreenState;
}
/** getScreenedAttentionItem (coherence-9). "withheld": restricted, gone, missing thread row or unparseable fingerprint;
 *  "screen_unavailable": an email thread/commitment item while the rules or screen rows can't be read. */
export type ScreenedItemResult =
  | { ok: true; item: AttentionFeedItem }
  | { ok: false; reason: "missing" | "withheld" | "screen_unavailable" };
export type OwnerAction = "seen" | "snooze" | "dismiss" | "resolve" | "reopen";
export type FeedbackReason = "useful" | "not_relevant" | "wrong_priority" | "already_handled" | "duplicate" | "wrong_facts" | "other";
