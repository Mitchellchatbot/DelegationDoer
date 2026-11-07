import type { InsertSafeProblem } from "@/lib/exec/drafts-doc";
import type {
  DraftAttention,
  DraftErrorCode,
  EaReadinessReason,
  ExecDraftStatus,
  FactsStatus,
  GenerationError,
  GenerationFlag,
  ReviewBlocker,
  SendTokenReason,
  SendUnavailable
} from "@/lib/exec/drafts-types";
import type { RecipientError } from "@/lib/exec/recipients";
import type { VoiceAttemptError } from "@/lib/exec/drafts-store";

// Every fixed sentence the drafts UI shows (P4 contract §3.13.4, UI12).
// Pure data keyed on the exported unions: a code this build doesn't know has
// no sentence (the caller shows a generic line), and a new union member
// without copy is a type error here. Nothing in this file comes from the mail
// service, the model or a mail header: the <...> parts are filled from DD's
// own data by the functions below. Client-safe (types only are imported).

// ---------------------------------------------------------------------------
// Route codes (DraftErrorCode) and the clone / last-error codes
// ---------------------------------------------------------------------------

export const ROUTE_CODE_SENTENCE: Readonly<Record<DraftErrorCode, string>> = Object.freeze({
  not_found: "This draft doesn't exist or isn't yours.",
  forbidden: "This request was blocked. Reload the page and try again.",
  bad_request: "The request was refused as malformed. Reload the page and try again.",
  invalid: "Some of this draft isn't valid. Check the highlighted parts.",
  drafts_off: "Assistant drafts are off.",
  send_off: "Sending from here is off. Open the draft in Outlook to send it.",
  drafts_unavailable: "Drafts are unavailable: <reason>.",
  send_unavailable: "Sending is unavailable: <reason>.",
  rate_limited: "Too many requests in the last 10 minutes. Try again in a minute.",
  version_conflict: "This draft changed elsewhere. Your last edit wasn't saved.",
  state_conflict: "This draft moved on (now <status>). The page has been refreshed.",
  review_required: "Review the draft again before sending.",
  review_expired: "The review expired after 10 minutes. Review again.",
  acks_missing: "Tick every warning before sending.",
  recipients_blocked: "Some recipients can't be used:",
  placeholders: "Fill in the [bracketed] placeholders first.",
  empty_body: "The draft is empty.",
  unsafe_markup: "The text contains something the mail service refuses: <construct>. Rephrase it.",
  instruction_required: "Tell the assistant what to write.",
  subject_required: "Add a subject.",
  thread_unavailable: "This email isn't available to reply to right now.",
  mailbox_problem: "Your mailbox connection needs attention. The System card has details.",
  audit_unavailable: "Couldn't record this action, so nothing was done. Try again shortly.",
  unavailable: "Couldn't reach a service this needs. Try again shortly.",
  hold: "An earlier draft for this email may already have been sent. Check your Sent Items in Outlook, then confirm.",
  sent_copy_found: "An earlier draft for this email was already sent.",
  // P5b F3 (C45)
  private_refs_unconfirmed: "Tick \"I've checked it\" first: this draft was started in a chat that also read other email, team notes or other clients' records."
});

/** A stored `throttled` (ui-5): the row keeps no wait time, so the notice names none. */
export const THROTTLED_SHORTLY_SENTENCE = "Outlook is busy. Try again shortly.";

/** `bad_request` when the clone, not DD, refused the request. */
export const CLONE_BAD_REQUEST_SENTENCE = "The mail service refused the request. The team has been told.";

/** The §2.6 answer codes and `last_error_code` values that carry a sentence of their own. */
export const CLONE_CODES = [
  "outcome_unknown", "mailbox_not_connected", "ea_auth", "thread_not_found", "account_not_found", "parent_missing",
  "idempotency_mismatch", "throttled", "mailbox_reconnect", "graph_error", "clone_not_ready", "timeout", "clone_error",
  "outlook_changed", "recreate_failed", "not_in_registry", "accepted", "changed", "already_sending", "already_sent",
  "sent_externally", "clone_anomaly", "send_disabled", "gone", "timeout_nothing_sent", "transport", "outlook_not_found",
  "outlook_unknown", "outlook_unknown_restricted", "outlook_reappeared", "expired_idle", "generation_stopped", "copied",
  // P5b F10: written by exec_drafts_purge_by_ids (RPC 5) on a chat draft whose chat used a now-restricted sender's mail.
  "chat_source_restricted"
] as const;
export type DraftCloneCode = (typeof CLONE_CODES)[number];

export const CLONE_CODE_SENTENCE: Readonly<Record<DraftCloneCode, string>> = Object.freeze({
  outcome_unknown: "We couldn't confirm the save. Checking…",
  mailbox_not_connected: "Mailbox connection needs attention.",
  ea_auth: "The mail service didn't accept DD's credentials. The team has been told.",
  thread_not_found: "This email thread isn't in the mail service any more.",
  account_not_found: "Your mailbox isn't in the mail service.",
  parent_missing: "The email you're replying to isn't in Outlook any more. DD won't start a new thread.",
  idempotency_mismatch: "Something went wrong saving this draft. The team has been told. Try again.",
  throttled: "Outlook is busy. Try again in <n> s.",
  mailbox_reconnect: "Your mailbox needs to be reconnected. The team has been told.",
  graph_error: "Outlook returned an error. Try again.",
  clone_not_ready: "The mail service is starting up. Try again in a minute.",
  timeout: "Outlook took too long to answer.",
  clone_error: "The mail service hit an error.",
  outlook_changed: "This draft was changed in Outlook after you saved it.",
  recreate_failed: "Your Outlook draft was removed. Save again to put it back.",
  not_in_registry: "Removed. The mail service had no record of it; the team has been told.",
  accepted: "Sent. Confirming it reached your Sent Items…",
  changed: "The draft changed in Outlook after your review. Review it again.",
  already_sending: "A send is already in progress. Don't send it again.",
  already_sent: "This draft was already sent.",
  sent_externally: "This draft, or an earlier version of it, was already sent from Outlook.",
  clone_anomaly: "The mail service answered unexpectedly. The team has been told. Don't send it again until this is checked.",
  send_disabled: "Sending isn't switched on for your mailbox yet.",
  gone: "This draft is no longer in your Outlook Drafts.",
  timeout_nothing_sent: "Outlook took too long. Nothing was sent; you can try again.",
  transport: "We lost the connection while sending. We can't tell yet whether it went out. Don't send it again.",
  outlook_not_found: "Outlook couldn't find this draft just now. Nothing was sent. We'll check again.",
  outlook_unknown: "We couldn't confirm whether this was saved to Outlook. Check your Outlook Drafts before saving again.",
  outlook_unknown_restricted: "This draft was for a restricted thread; its content was removed. An Outlook copy may remain: check your Outlook Drafts.",
  outlook_reappeared: "An older Outlook draft for this thread is back in your Drafts. Delete it in Outlook.",
  expired_idle: "Closed after 30 days without changes.",
  generation_stopped: "You stopped drafting. Your previous text is unchanged.",
  copied: "A new draft was made from this one.",
  chat_source_restricted: "Content removed: the chat that started this draft used mail from a sender that is now restricted."
});

export const GENERATION_FAILED_SENTENCE: Readonly<Record<GenerationError, string>> = Object.freeze({
  declined: "The assistant won't draft this one. Write it yourself.",
  truncated: "The draft came back cut off. Try again.",
  invalid_output: "The draft didn't come back in a usable form. Try again.",
  budget: "Today's AI spend cap is reached.",
  input_too_large: "This thread is too long to draft from.",
  thread_unavailable: "The email isn't available to draft from.",
  restricted: "The email isn't available to draft from.",
  model_error: "Couldn't reach the model. Try again.",
  timeout: "Drafting took too long. Try again.",
  stale: "Drafting took too long. Try again.",
  stopped: "You stopped drafting."
});

export const GENERATION_ERRORS: readonly GenerationError[] = Object.freeze([
  "declined", "truncated", "invalid_output", "budget", "input_too_large", "thread_unavailable", "restricted", "model_error",
  "timeout", "stale", "stopped"
]);

/** `generation_<code>` (a failed regenerate, C6): the sentence for the code, then the unchanged-text line. */
export function regenerateFailedSentence(code: GenerationError): string {
  return `Regenerating failed: ${GENERATION_FAILED_SENTENCE[code]} Your previous text is unchanged.`;
}

export const UNSAFE_CONSTRUCT_WORDS: Readonly<Record<InsertSafeProblem, string>> = Object.freeze({
  script_tag: "a script tag",
  frame_tag: "a frame tag",
  object_tag: "an embedded object tag",
  form_tag: "a form tag",
  base_tag: "a base tag",
  meta_tag: "a meta tag",
  link_tag: "a link tag",
  event_attribute: "a word starting with 'on' followed by '='",
  script_url: "a 'javascript:' link"
});

export const STATUS_WORDS: Readonly<Record<ExecDraftStatus, string>> = Object.freeze({
  generating: "drafting",
  generation_failed: "drafting failed",
  draft: "a draft in DD",
  saving: "saving to Outlook",
  saved: "saved in Outlook",
  sending: "sending",
  sent_pending: "sent, being confirmed",
  unknown: "outcome unknown",
  sent: "sent",
  sent_external: "sent from Outlook",
  gone: "gone from Outlook",
  discarding: "being discarded",
  discarded: "discarded"
});

/** The Drafts bucket's status chip. */
export const STATUS_CHIP: Readonly<Record<ExecDraftStatus, string>> = Object.freeze({
  generating: "Drafting",
  generation_failed: "Drafting failed",
  draft: "In DD",
  saving: "Saving",
  saved: "In Outlook",
  sending: "Sending",
  sent_pending: "Sent, confirming",
  unknown: "Outcome unknown",
  sent: "Sent",
  sent_external: "Sent from Outlook",
  gone: "Gone from Outlook",
  discarding: "Discarding",
  discarded: "Discarded"
});

// ---------------------------------------------------------------------------
// Reasons, banners, flags
// ---------------------------------------------------------------------------

export type UnavailableReason = EaReadinessReason | SendUnavailable | "drafts_off" | "mailbox_problem";

export const REASON_WORDS: Readonly<Record<UnavailableReason, string>> = Object.freeze({
  no_pin: "your mailbox isn't linked to the assistant",
  multiple_principals: "more than one assistant owner has a mailbox linked",
  token_missing: "the drafting key isn't set",
  base_url_missing: "the mail service address isn't set",
  clone_unreachable: "the mail service can't be reached",
  cl2_missing: "the mail service doesn't support assistant drafts yet",
  cl2_not_ready: "the mail service is still starting its drafts feature",
  me_failed: "the mail service couldn't check the drafting key",
  me_no_auth: "the mail service didn't recognise the drafting key",
  not_scoped: "the drafting key is the wrong kind",
  wrong_scopes: "the drafting key has the wrong permissions",
  wrong_accounts: "the drafting key is for a different mailbox",
  token_expired: "the drafting key has expired",
  drafts_off: "assistant drafts are off",
  mailbox_problem: "your mailbox connection needs attention",
  send_off: "sending from here is off",
  clone_send_off: "the mail service hasn't switched sending on for your mailbox",
  send_token: "the sending key is missing or wrong"
});

/** The send token's own self-check reasons (the System card's "Send token" row). */
export const SEND_TOKEN_REASON_WORDS: Readonly<Record<SendTokenReason, string>> = Object.freeze({
  token_missing: "the sending key isn't set",
  malformed: "the sending key can't be read",
  not_scoped: "the sending key is the wrong kind",
  wrong_scopes: "the sending key has the wrong permissions",
  wrong_accounts: "the sending key is for a different mailbox",
  token_expired: "the sending key has expired"
});

export function sendTokenReasonWords(reason: string | null | undefined): string {
  if (typeof reason !== "string" || reason === "") return "the reason isn't known";
  return Object.prototype.hasOwnProperty.call(SEND_TOKEN_REASON_WORDS, reason) ? SEND_TOKEN_REASON_WORDS[reason as SendTokenReason] : reason;
}

/** The reason's words, or the code itself when this build doesn't know it (never a blank). */
export function reasonWords(reason: string | null | undefined): string {
  if (typeof reason !== "string" || reason === "") return "the reason isn't known";
  return Object.prototype.hasOwnProperty.call(REASON_WORDS, reason) ? REASON_WORDS[reason as UnavailableReason] : reason;
}

export const DRAFTS_UNAVAILABLE_SENTENCE = (reason: string | null | undefined) => `Drafts are unavailable: ${reasonWords(reason)}.`;
export const SEND_UNAVAILABLE_SENTENCE = (reason: string | null | undefined) => `Sending is unavailable: ${reasonWords(reason)}.`;

export const FACTS_REASON_WORDS: Readonly<Record<Extract<FactsStatus, "medium_confidence" | "unavailable" | "recipients_outside_client">, string>> =
  Object.freeze({
    medium_confidence: "the client match isn't certain",
    unavailable: "client status couldn't be read",
    recipients_outside_client: "a recipient isn't at <client>"
  });

/** "No client status used: <words>." for the statuses that get a banner; null for the others. */
export function factsBanner(status: FactsStatus | null, clientName: string | null = null): string | null {
  if (status !== "medium_confidence" && status !== "unavailable" && status !== "recipients_outside_client") return null;
  return `No client status used: ${FACTS_REASON_WORDS[status].replace("<client>", clientName ?? "the client")}.`;
}

export const FLAG_WORDS: Readonly<Record<GenerationFlag, string>> = Object.freeze({
  unexpected_url: "a link",
  unexpected_email: "an email address",
  unexpected_phone: "a phone number",
  unexpected_amount: "an amount of money",
  unexpected_number: "a long number, like an account number",
  other_client_name: "another client's name",
  teammate_name: "a teammate's name"
});

/** "a link, an email address and a phone number" (commas and "and"). */
export function joinWords(words: readonly string[]): string {
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function flagKinds(flags: readonly GenerationFlag[]): string {
  const seen = new Set<GenerationFlag>();
  const words: string[] = [];
  for (const f of flags) {
    if (seen.has(f) || !Object.prototype.hasOwnProperty.call(FLAG_WORDS, f)) continue;
    seen.add(f);
    words.push(FLAG_WORDS[f]);
  }
  return joinWords(words);
}

/** The C65 banner, or null when nothing was flagged. */
export function flagsBanner(flags: readonly GenerationFlag[]): string | null {
  const kinds = flagKinds(flags);
  return kinds === "" ? null : `Check before sending: the assistant added ${kinds} that weren't in your instruction or the client facts.`;
}

// ---------------------------------------------------------------------------
// Review blockers and recipient entries
// ---------------------------------------------------------------------------

export const BLOCKER_COPY: Readonly<Record<ReviewBlocker, string>> = Object.freeze({
  already_replied: "A reply may already have gone out on this thread: a newer message from you, or an earlier draft for this email. Send anyway",
  newer_inbound: "A newer message arrived since this draft was written. Send anyway",
  reply_scheduled: "A reply is already scheduled on this thread. Send anyway",
  legacy_draft_pending: "A reply draft is waiting for approval on this thread. Send anyway",
  opened_in_outlook: "I've closed this draft in Outlook and nobody else is editing it",
  changed_in_outlook: "This draft was changed in Outlook since you saved it. Send this version",
  recipients_changed: "The recipients were changed in Outlook. Send to these recipients",
  reply_to_present: "Replies to this email will go to the Reply-To address above",
  placeholder_in_outlook: "The Outlook version contains a [bracketed] placeholder. Send anyway",
  thread_unavailable: "The thread couldn't be checked for newer messages. Send anyway",
  facts_outside_client: "This draft uses internal status for <client>, and a recipient isn't at <client>. Send anyway",
  unexpected_content: "The assistant added <kinds> that weren't in your instruction or the client facts. I've checked them",
  // P5b F4 (C45)
  private_refs: "This draft was started in a chat that also read other email, team notes or other clients' records. I've checked it shares nothing it shouldn't"
});

/** A blocker's checkbox label with its <client> / <kinds> parts filled from DD data. */
export function blockerCopy(blocker: ReviewBlocker, ctx: { clientName?: string | null; flags?: readonly GenerationFlag[] } = {}): string {
  const base = BLOCKER_COPY[blocker] ?? String(blocker);
  const kinds = flagKinds(ctx.flags ?? []);
  return base.split("<client>").join(ctx.clientName ?? "the client").split("<kinds>").join(kinds === "" ? "content" : kinds);
}

export const RECIPIENT_ERRORS: readonly RecipientError[] = Object.freeze([
  "empty_to", "invalid_address", "own_address", "no_reply_address", "restricted_recipient", "too_many", "not_allowed",
  "to_not_derived", "bcc_on_reply", "from_mismatch", "sender_mismatch", "reply_to_restricted", "facts_recipient"
]);

const RECIPIENT_ENTRY: Readonly<Record<RecipientError, string>> = Object.freeze({
  empty_to: "Add at least one recipient in To.",
  invalid_address: "<address> isn't a valid email address.",
  own_address: "<address> is your own address.",
  no_reply_address: "<address> doesn't accept replies.",
  restricted_recipient: "<address> is on the restricted list.",
  too_many: "More than 20 recipients.",
  not_allowed: "<address> isn't one of the people you can add here. Write to someone new from Outlook.",
  to_not_derived: "<address> wasn't on the email you're replying to.",
  bcc_on_reply: "Replies can't have Bcc.",
  from_mismatch: "The Outlook draft would go out from <address>, not your mailbox.",
  sender_mismatch: "The Outlook draft's sender is <address>, not your mailbox.",
  reply_to_restricted: "The Reply-To address <address> is on the restricted list.",
  facts_recipient: "This draft uses internal status for <client>, and <address> isn't at <client>. Remove them, or regenerate to draft without client status."
});

/** ui-4: the entries whose <address> sits mid-sentence, worded for an answer that names no address. */
const RECIPIENT_ENTRY_NO_ADDRESS: Readonly<Partial<Record<RecipientError, string>>> = Object.freeze({
  from_mismatch: "The Outlook draft would go out from an address that isn't your mailbox.",
  sender_mismatch: "The Outlook draft's sender isn't your mailbox.",
  reply_to_restricted: "A Reply-To address is on the restricted list.",
  facts_recipient: "This draft uses internal status for <client>, and a recipient isn't at <client>. Remove them, or regenerate to draft without client status."
});

export const isRecipientError = (code: string): code is RecipientError => Object.prototype.hasOwnProperty.call(RECIPIENT_ENTRY, code);

/**
 * One line of a `recipients_blocked` answer. The address is DD's stored, lowercased one (never a display name,
 * C75). A code this build doesn't know is the generic sentence, never the raw code (ui-3).
 */
export function recipientEntry(code: RecipientError | string, address: string | null, clientName: string | null = null): string {
  if (!isRecipientError(code)) return GENERIC_FAILURE_SENTENCE;
  const base = address === null ? RECIPIENT_ENTRY_NO_ADDRESS[code] ?? RECIPIENT_ENTRY[code] : RECIPIENT_ENTRY[code];
  return base.split("<address>").join(address ?? "An address").split("<client>").join(clientName ?? "the client");
}

// ---------------------------------------------------------------------------
// Resolving any code to its sentence
// ---------------------------------------------------------------------------

export interface CodeContext {
  /** `drafts_unavailable` / `send_unavailable` reason; `throttled`'s seconds; `state_conflict`'s status; `unsafe_markup`'s constructs. */
  reason?: string | null;
  retryAfterSec?: number | null;
  status?: ExecDraftStatus | string | null;
  constructs?: readonly string[];
  /** A `bad_request` the clone answered (the route says so with `from: "clone"`). */
  fromClone?: boolean;
}

const GENERATION_PREFIX = "generation_";

/**
 * The fixed sentence for a route code, a §2.6 / last-error code or a
 * `generation_<code>`, with its <...> parts filled from `ctx` (DD data only),
 * or null for a code this build doesn't know. Never clone text.
 */
export function codeSentence(code: string | null | undefined, ctx: CodeContext = {}): string | null {
  if (typeof code !== "string" || code === "") return null;
  if (Object.prototype.hasOwnProperty.call(ROUTE_CODE_SENTENCE, code)) {
    const route = code as DraftErrorCode;
    switch (route) {
      case "drafts_unavailable":
        return DRAFTS_UNAVAILABLE_SENTENCE(ctx.reason);
      case "send_unavailable":
        return SEND_UNAVAILABLE_SENTENCE(ctx.reason);
      case "state_conflict": {
        const status = typeof ctx.status === "string" && Object.prototype.hasOwnProperty.call(STATUS_WORDS, ctx.status)
          ? STATUS_WORDS[ctx.status as ExecDraftStatus]
          : "changed";
        return ROUTE_CODE_SENTENCE.state_conflict.replace("<status>", status);
      }
      case "unsafe_markup": {
        const words = (ctx.constructs ?? [])
          .filter((c): c is InsertSafeProblem => Object.prototype.hasOwnProperty.call(UNSAFE_CONSTRUCT_WORDS, c))
          .map((c) => UNSAFE_CONSTRUCT_WORDS[c]);
        return ROUTE_CODE_SENTENCE.unsafe_markup.replace("<construct>", words.length > 0 ? joinWords(words) : "something it can't send");
      }
      case "bad_request":
        return ctx.fromClone ? CLONE_BAD_REQUEST_SENTENCE : ROUTE_CODE_SENTENCE.bad_request;
      default:
        return ROUTE_CODE_SENTENCE[route];
    }
  }
  if (Object.prototype.hasOwnProperty.call(CLONE_CODE_SENTENCE, code)) {
    const clone = code as DraftCloneCode;
    if (clone === "throttled") {
      const n = typeof ctx.retryAfterSec === "number" && Number.isFinite(ctx.retryAfterSec) && ctx.retryAfterSec > 0 ? Math.ceil(ctx.retryAfterSec) : 30;
      return CLONE_CODE_SENTENCE.throttled.replace("<n>", String(n));
    }
    return CLONE_CODE_SENTENCE[clone];
  }
  if (code.startsWith(GENERATION_PREFIX)) {
    const rest = code.slice(GENERATION_PREFIX.length);
    if (Object.prototype.hasOwnProperty.call(GENERATION_FAILED_SENTENCE, rest)) return regenerateFailedSentence(rest as GenerationError);
  }
  return null;
}

/** When no code applies: a generic line that still tells him what to do. */
export const GENERIC_FAILURE_SENTENCE = "Something went wrong. Reload the page and try again.";

// ---------------------------------------------------------------------------
// Lists, chips, the System card
// ---------------------------------------------------------------------------

export const ATTENTION_REASON: Readonly<Record<DraftAttention, string>> = Object.freeze({
  unknown: "Outcome unknown",
  sent_mismatch: "Sent copy didn't match",
  gone_unconfirmed: "Checking whether it was sent",
  outlook_changed: "Changed in Outlook",
  generation_failed: "Drafting failed",
  restricted: "Restricted thread",
  stale_link: "Outlook copy is older"
});

/** L15: the email list's chip for a thread's active exec draft, or null when its status gets none. */
export function draftChipLabel(status: ExecDraftStatus | string | null | undefined): string | null {
  switch (status) {
    case "generating":
      return "Drafting…";
    case "draft":
    case "saved":
      return "Draft ready";
    case "unknown":
      return "Check Sent Items";
    default:
      return null;
  }
}

/** The thread page's "Open draft (<status>)" words. */
export function openDraftLabel(status: ExecDraftStatus | string): string {
  const words = Object.prototype.hasOwnProperty.call(STATUS_WORDS, status) ? STATUS_WORDS[status as ExecDraftStatus] : String(status);
  return `Open draft (${words})`;
}

export const VOICE_ERROR_WORDS: Readonly<Record<VoiceAttemptError, string>> = Object.freeze({
  declined: "the model declined",
  truncated: "the answer was cut off",
  invalid_output: "the answer was malformed",
  budget: "today's AI budget was used up",
  input_too_large: "the samples were too long",
  read_failed: "your sent mail couldn't be read",
  feed_unsupported: "the mail service can't list sent mail"
});

export function voiceErrorWords(code: string | null | undefined): string {
  if (typeof code !== "string" || code === "") return "an unknown error";
  return Object.prototype.hasOwnProperty.call(VOICE_ERROR_WORDS, code) ? VOICE_ERROR_WORDS[code as VoiceAttemptError] : code;
}

// ---------------------------------------------------------------------------
// Fixed lines
// ---------------------------------------------------------------------------

export const COPY = Object.freeze({
  checkedOutlook: "I checked my Sent Items in Outlook",
  noAttachments: "No attachments in assistant drafts. Add them in Outlook.",
  utcTimes: "Quoted times will be in UTC",
  signatureAdded: "Your stored signature was added",
  signatureSkipped: "Your signature wasn't added",
  openInOutlookWarning: "Send from one place only. If this draft is open in Outlook, close it first.",
  sendOffHint: "Sending from here isn't switched on yet. Open it in Outlook to send.",
  previewRefused: "The preview couldn't be built safely. Open the draft in Outlook to check it.",
  linksDontOpen: "Links in this preview don't open.",
  previewCut: "This preview is cut off: the email is too long to show in full. Check the whole draft in Outlook before sending.",
  sendsImmediately: "Sends immediately. There's no undo.",
  pollRetrying: "Couldn't refresh. Retrying…",
  pollGiveUp: "Couldn't refresh this draft. Reload the page.",
  deleteRestrictedConfirm: "Delete this draft from your Outlook Drafts? It moves to Deleted Items.",
  injectionWarning: "This email seems to contain instructions aimed at the assistant. Read it yourself before sending what it drafted.",
  newEmailIntro: "New email from your mailbox. Recipients: your team, client contacts, and people you've emailed.",
  bucketEmpty: "No drafts. Use Draft reply on an email to start one.",
  bucketUnavailable: "Drafts couldn't load. Reload to try again.",
  bucketOff: "Assistant drafts are off.",
  bucketNotInstalled: "Assistant drafts aren't set up yet.",
  restrictedRow: "Draft for a restricted thread",
  pageOff: "Assistant drafts are off. The team turns them on.",
  pageNotInstalled: "Assistant drafts aren't set up yet",
  newNoAnchor: "This email has nothing to reply to here: it has no message from someone else, or its newest one isn't available. Open the thread to check.",
  newHold: "An earlier draft for this email may already have been sent. Check your Sent Items in Outlook first.",
  newSentCopyFound: "An earlier draft for this email was already sent.",
  /** L13: next to "Open in Outlook" on a saved draft. */
  outlookEditWarning: "If you edit or send it in Outlook, don't send it here too. Close it in Outlook before sending from DD.",
  openItNow: "The popup was blocked. Open it now:",
  openFailed: "Couldn't record that you opened it, so it wasn't opened. Try again.",
  recheckReadiness: "Check again",
  recheckingReadiness: "Checking…",
  newEmailNoRecipients: "Add at least one recipient in To.",
  instructionLabel: "What should the assistant write?",
  instructionPlaceholder: "For example: thank them, confirm Thursday at 2 pm works, and ask for the agenda.",
  subjectLabel: "Subject",
  outlookVersionTitle: "The draft as it is in Outlook now",
  pageUnavailable: "Couldn't check this email right now. Try again shortly.",
  viewThread: "View the thread",
  backToDrafts: "Drafts",
  // P5b F5 (C44, C45)
  privateRefsNotice: "Started in a chat that also read other email, team notes or other clients' records. Check the draft doesn't share any of it.",
  privateRefsCheck: "I've checked it",
  instructionByAssistant: "Written by the assistant in Chat"
});

/** The new-reply banner (C75): "Draft a reply to <address> (<name>)." The address leads; the name is data. */
export function draftReplyBanner(to: { address: string; name: string | null } | null): string {
  if (to === null) return "Draft a reply.";
  return to.name ? `Draft a reply to ${to.address} (${to.name}).` : `Draft a reply to ${to.address}.`;
}

export const ADDRESS_FALLBACK = "(no address)";
