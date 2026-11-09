import type { PrivateRefKind } from "@/lib/exec/agent/types";

// Every user-facing fixed string of chat (contract §3.13.6 and §3.19; lead
// seed, frozen), so the server (run.ts, turn.ts, prompt.ts's replay) and the
// UI share one copy. Pure and client-safe: no server-only, one type-only
// import. The texts are exact; a change here is a contract change.
//
// The Settings rows' labels and help text live in settings-fields.ts
// (SETTINGS_FIELDS, Area A), which imports nothing; only the section's
// not-installed sentence is here.

// ---------------------------------------------------------------------------
// §3.13.6 fixed copy (the names are the contract's)
// ---------------------------------------------------------------------------

export const REFUSED_TEXT = "I can't help with that request. Start a new conversation to ask something else.";
export const FAILED_TEXT = "Something went wrong, so there's no answer. Try again.";
export const CHAT_PAUSED_TEXT = "Chat is paused until tomorrow (daily budget).";
export const CAPPED_NOTE = "_I stopped here: this question used up its tool budget, so some things weren't checked._";
export const TRUNCATED_NOTE = "_This answer hit its length limit and was cut off._";
export const DEADLINE_NOTE = "_I stopped here because this was taking too long, so some things weren't checked._";
export const TOOL_BUDGET_RESULT = "Tool budget for this question is used up. Answer now with what you have and say what you couldn't check.";
export const TOO_MANY_TOOLS_RESULT = "Too many tool calls in one step: at most 8 run per step. Ask for the rest in your next step.";
export const REDACTED_TEXT = "[Removed: this answer drew on mail from a sender that is now restricted.]";
export const UNCHECKED_TEXT = "[Hidden: the senders of the mail this answer used couldn't be checked. Ask again.]";
export const REPLAY_REFUSED = "[No answer: the request was declined.]";
export const REPLAY_FAILED = "[No answer: an error occurred.]";
export const REPLAY_STOPPED = "[Stopped before it finished.]";
export const REPLAY_STOPPED_EMPTY = "[No answer: stopped before it finished.]";
export const REPLAY_DECLINED_QUESTION = "[A question that was declined.]";
export const REPLAY_BLANK = "[No answer text.]";
export const PROPOSAL_PRIVACY_NOTICE = "Written in a conversation that read your email or team notes. Check it doesn't quote anything private.";
/** The template; draftPrivateRefsText fills {kinds}. */
export const DRAFT_PRIVATE_REFS = "Started in a conversation that also read {kinds}. You'll be asked to confirm before saving or sending.";
export const PRIVATE_REF_KIND_LABELS: Readonly<Record<PrivateRefKind, string>> = Object.freeze({
  other_threads: "other email threads",
  dd_text: "team notes or comments",
  other_clients: "other clients' records",
  // P7b (§3.17.3 D8; stage-0 seed, forced by the Record type).
  private_slack: "private Slack"
});

/** DRAFT_PRIVATE_REFS with the kinds' labels, in the given order, joined "a", "a and b", "a, b and c". */
export function draftPrivateRefsText(kinds: readonly PrivateRefKind[]): string {
  const labels = [...new Set(kinds)].map((k) => PRIVATE_REF_KIND_LABELS[k]).filter((l): l is string => typeof l === "string");
  const joined = labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return DRAFT_PRIVATE_REFS.replace("{kinds}", joined);
}

// ---------------------------------------------------------------------------
// §3.19.5 states and copy
// ---------------------------------------------------------------------------

export const CHAT_EMPTY_HEADING = "Ask about the company";
// P7b fixer (ui-5, a lead copy change): state-neutral, true whether or not Slack reading is on (P7b's chat reads Slack
// digests, recorded items and a few channels live once it is).
export const CHAT_EMPTY_SUB = "Answers come from DD, your mailbox and the Slack conversations the assistant reads, with sources.";
/** ui-10 (a copy addition for the lead): the empty state when email intelligence is off or has no pinned mailbox. */
export const CHAT_EMPTY_SUB_NO_EMAIL = "Answers come from DD and the Slack conversations the assistant reads, with sources. Email isn't turned on.";
/** Starters for the rail and the page. */
export const CHAT_STARTERS: readonly string[] = Object.freeze([
  "Give me an update on the entire team's progress",
  "What is everyone currently working on?",
  "Which projects are falling behind?",
  "Who has overdue tasks?",
  "Which tasks are waiting for my approval?",
  "Are there any recurring operational problems?",
  "Catch me up on everything important today",
  "What did I miss yesterday?"
]);
/** Starters for the drawer opened on a client: no client name in the question (b-security-12; the context ref carries it). */
export const CHAT_CLIENT_STARTERS: readonly string[] = Object.freeze([
  "How is this client doing right now?",
  "What's open for this client and who owns it?",
  "What did we ship for this client lately?",
  "Summarize recent emails with this client."
]);
/** ui-10: the client starters when no tool can read his mailbox (the email one dropped). */
export const CHAT_CLIENT_STARTERS_NO_EMAIL: readonly string[] = Object.freeze(CHAT_CLIENT_STARTERS.filter((s) => !/\bemails?\b/i.test(s)));

export const CONTEXT_CHIP_PREFIX = "Asking about: ";
export function contextChipText(label: string): string {
  return `${CONTEXT_CHIP_PREFIX}${label}`;
}

/** B5: the question's limit, and where the composer starts counting. */
export const CHAT_TEXT_MAX = 4000;
export const COMPOSER_COUNTER_FROM = 3500;
export const COMPOSER_PLACEHOLDER = "Ask a question…";
/** "{n}/4,000", shown past COMPOSER_COUNTER_FROM characters. */
export function composerCounterText(n: number): string {
  return `${Math.max(0, Math.floor(n)).toLocaleString("en-US")}/4,000`;
}
export const SEND_BUTTON = "Send";
export const STOP_BUTTON = "Stop";
export const TRY_AGAIN_BUTTON = "Try again";

export const CONNECTING_TEXT = "Connecting…";
/** "Quiet ≥ 10 s": no event for this long shows the still-working line. */
export const QUIET_AFTER_MS = 10_000;
export function stillWorkingText(seconds: number): string {
  return `Still working… ${Math.max(0, Math.floor(seconds))}s`;
}
/** ui-4: what a screen reader hears instead of the ticking counter (the counter is aria-hidden). */
export const STILL_WORKING_SR = "Still working";
/** ui-4: the one polite announcement when a turn settles. */
export const ANSWER_READY_SR = "Answer ready";
export const ANSWER_STOPPED_SR = "Answer stopped";
export const ANSWER_FAILED_SR = "Couldn't answer";

export type ToolLineState = "running" | "done" | "error" | "skipped";
/** §3.11.5: "{label}…", "{label}", "{label}: couldn't finish", "{label}: skipped (tool budget)". */
export function toolLineText(label: string, state: ToolLineState): string {
  switch (state) {
    case "running":
      return `${label}…`;
    case "done":
      return label;
    case "error":
      return `${label}: couldn't finish`;
    case "skipped":
      return `${label}: skipped (tool budget)`;
  }
}

export const SOURCES_LABEL = "Sources";
export const RECOMMENDATION_LABEL = "Recommendation";
export const RECOMMENDATION_SUB = "Suggestions, not facts";
export const STOPPED_LABEL = "Stopped";

export const BANNER_RATE_LIMITED = "You've asked a lot in the last 10 minutes. Try again in a few minutes.";
export const BANNER_BUSY = "Still answering your last question in this conversation. Wait for it, or start a new conversation.";
export const BANNER_BUSY_PRINCIPAL = "Two answers are already being written. Wait for one to finish, then ask again.";
export const BANNER_CHAT_OFF = "Chat is turned off in Settings.";
export const BANNER_CONTEXT_UNAVAILABLE = "That item isn't available anymore.";
/** context_unavailable with reason check_failed. */
export const BANNER_CONTEXT_CHECK_FAILED = "That item couldn't be checked just now. Try again in a minute.";
export const BANNER_LOST = "Lost the connection. Checking whether the answer finished…";
/** Shown with TRY_AGAIN_BUTTON (the retry action: the same client turn id, C50). */
export const BANNER_SEND_FAILED = "Couldn't send. Check your connection and try again.";
export const BANNER_NOT_SAVED = "This answer wasn't saved.";
export const BANNER_UNAVAILABLE = "Chat isn't available right now. Reload the page.";

// Proposal card (C23, b-security-4)
export const PROPOSAL_UNASSIGNED = "Unassigned";
export function proposalExpiresText(age: string): string {
  return `Expires ${age}`;
}
export const CONFIRM_BUTTON = "Confirm";
export const DISMISS_BUTTON = "Dismiss";
export const PROPOSAL_CONFIRMING = "Creating the task…";
export const PROPOSAL_CONFIRMED = "Task created";
export const OPEN_TASK_LINK = "Open task";
export const PROPOSAL_DISMISSED = "Dismissed";
export const PROPOSAL_EXPIRED = "Expired. Ask again to propose it.";
/** withdrawn, or redacted in any status. */
export const PROPOSAL_REMOVED = "Removed";
export const PROPOSAL_CHANGED = "This proposal changed since it was shown. Check it again before confirming.";
export const PROPOSAL_ERROR = "Couldn't create the task. Try again.";
/** ui-8 (copy additions for the lead): a failed Dismiss; a confirm the assignee can't take any more. */
export const PROPOSAL_DISMISS_ERROR = "Couldn't dismiss it. Try again.";
export const PROPOSAL_ASSIGNEE_GONE = "The assignee isn't in DD anymore. Ask again to propose it for someone else.";
/** ui-9: a card stuck in confirming re-posts the (idempotent) confirm, which resumes it or answers it's still in progress. */
export const PROPOSAL_CHECK_AGAIN = "Check again";

// Draft card
export const DRAFT_STARTED = "Draft started";
export const DRAFT_EXISTING = "A draft already exists for this thread";
export const OPEN_DRAFT_LINK = "Open draft";

/** The frame guard is false: action buttons are hidden. */
export const FRAMED_TEXT = "Open DD directly to act on this.";

// ---------------------------------------------------------------------------
// §3.19.7-§3.19.12 pages, rail, drawer, tabs, links, Settings
// ---------------------------------------------------------------------------

export const CHAT_OFF_PAGE_TEXT = "Chat is off. Turn it on in Settings.";
export const CONVERSATION_UNAVAILABLE_TEXT = "That conversation isn't available.";
export const RAIL_TITLE = "Ask";
export const OPEN_IN_CHAT_LINK = "Open in Chat";
/** The drawer's subtitle, inside the lazy panel's header slot (never in the shared drawer file, §3.20 item 6). */
export const DRAWER_SUBTITLE = "Answers with sources from DD and your mailbox";
/** ui-10: the drawer's subtitle when no tool can read his mailbox. */
export const DRAWER_SUBTITLE_NO_EMAIL = "Answers with sources from DD";
export const CHAT_TAB_LABEL = "Chat";
export const ASK_ABOUT_PROJECT_LINK = "Ask about this project";
export const ASK_ABOUT_THREAD_LINK = "Ask about this thread";
export const CHAT_NOT_INSTALLED_TEXT = "Chat isn't installed yet (the P5b migration hasn't been applied).";
