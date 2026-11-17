import { formatInZone } from "@/lib/exec/format";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { P10_LIMITS, REPLY_ACKABLE } from "@/lib/exec/slack-p10-types";
import type { ReplyBlocker, ReplyGenerationError, ReplyStatus, SendRefusal } from "@/lib/exec/slack-p10-types";
import type { ReplyDraftPageView } from "@/lib/exec/slack-reply-view";

// P10 the reply page's pure logic (contract §3.5.13, v1.1 product-3, -6, -8, -15, -16, -20; Area D; client-safe: the P10 copy,
// format.ts and types only). The editor, the send dialog, the chat card, the catch-up list and the feed read their words and
// their switches from here, so the rules are tested once, without a browser.

export type ReplyPageDraft = NonNullable<ReplyDraftPageView["draft"]>;
const COPY = SLACK_P10_COPY.replies;

/** The reply pages' own words, by the names the pages use. P10 fixer ui-9: every one is a §3.2 string now (SLACK_P10_COPY,
 *  pinned by p10-seed.test.ts); the Rewrite box reuses replies.instructionLabel. */
export const REPLY_UI_COPY = Object.freeze({
  checking: COPY.reviewChecking,
  failed: COPY.callFailed,
  rewriteInstructionLabel: COPY.instructionLabel,
  replyPageLink: COPY.openReplyPage,
  off: COPY.pageOff,
  notAllowed: COPY.notAllowed,
  cap: COPY.createCap
});

/** A create refusal (CreateReplyRefusal, the route's 409 codes) in words. */
export function createRefusalText(code: string): string {
  switch (code) {
    case "off":
    case "not_installed":
      return REPLY_UI_COPY.off;
    case "not_reading":
      return SLACK_P10_COPY.replies.readingOff;
    case "finance_slack":
      return SLACK_P10_COPY.replies.toolFinanceSlack;
    case "cap":
    case "rate_limited":
      return REPLY_UI_COPY.cap;
    case "already_posted":
      return SLACK_P10_COPY.replies.alreadyPosted;
    case "unavailable":
      return REPLY_UI_COPY.failed;
    default:
      return REPLY_UI_COPY.notAllowed;
  }
}

/** §3.5.13: the editor and the chat card poll every 2 s while generating / sending, for at most 3 minutes. */
export const REPLY_POLL_MS = 2_000;
export const REPLY_POLL_MAX_MS = 180_000;

/** Milliseconds until the next poll, or null when the status needs none (or the 3 minutes are up). */
export function replyPollIntervalFor(status: ReplyStatus | null, elapsedMs: number): number | null {
  if (status !== "generating" && status !== "sending") return null;
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < REPLY_POLL_MAX_MS ? REPLY_POLL_MS : null;
}

/** One live-region line (v1.1 product-20): role="status" for drafting, rewriting, sending and sent; role="alert" for back to
 *  draft, unknown and refusals. */
export interface ReplyBanner { role: "status" | "alert"; tone: "progress" | "ok" | "warn" | "danger" | "muted"; text: string }

const GENERATION_RETRYABLE: ReadonlySet<ReplyGenerationError> = new Set<ReplyGenerationError>([
  "refused", "truncated", "invalid_output", "empty", "too_long", "copied_external", "timeout", "model_error", "context_unavailable"
]);
const GENERATION_ERRORS: ReadonlySet<string> = new Set<string>([...GENERATION_RETRYABLE, "budget", "reading_off", "channel", "context_deleted", "author_optout"]);

/** "Couldn't draft a reply (…)." plus "Try again." where it can help, or the next step (budget, reading off). */
export function generationFailedText(error: ReplyGenerationError | null): string {
  const reason = error !== null ? COPY.reasons[error] : COPY.reasons.model_error;
  const line = fillP10(COPY.generationFailed, { reason });
  if (error !== null && GENERATION_RETRYABLE.has(error)) return `${line} ${COPY.tryAgainHint}`;
  if (error === "budget" || error === "reading_off") return `${line} ${COPY.nextSteps[error]}`;
  return line;
}

/** A Slack refusal code in words (sendReasons; anything unlisted is "Slack refused it"). */
export function sendReasonText(code: string): string {
  const reasons = COPY.sendReasons as Readonly<Record<string, string>>;
  return Object.prototype.hasOwnProperty.call(reasons, code) ? reasons[code] : reasons.other;
}

/** A clock time in his zone ("—" for a missing one). */
const timeIn = (iso: string | null, tz: string, nowIso: string): string => formatInZone(iso, tz, "time", nowIso);

/** The draft's state as one live-region line, or null when the state needs none (a plain draft). */
export function replyStatusBanner(d: Pick<ReplyPageDraft, "status" | "statusReason" | "version" | "generationError" | "sentAt" | "verifyingUntil" | "ownerResolution">,
  tz: string, nowIso: string): ReplyBanner | null {
  switch (d.status) {
    case "generating":
      return { role: "status", tone: "progress", text: d.version >= 1 ? COPY.rewriting : COPY.generating };
    case "generation_failed":
      return { role: "alert", tone: "danger", text: generationFailedText(d.generationError) };
    case "draft": {
      const code = d.statusReason;
      if (code === null) return null;
      if (GENERATION_ERRORS.has(code)) return { role: "alert", tone: "warn", text: fillP10(COPY.rewriteFailed, { reason: COPY.reasons[code as ReplyGenerationError] }) };
      return { role: "alert", tone: "warn", text: fillP10(COPY.backToDraft, { reason: sendReasonText(code) }) };
    }
    case "sending":
      return { role: "status", tone: "progress", text: COPY.sending };
    case "sent":
      // P10 fixer ui-11: with the date (and the year when needed), as replyStatusLabel says it: the page stays viewable for days.
      return { role: "status", tone: "ok", text: fillP10(COPY.sent, { time: formatInZone(d.sentAt, tz, "datetime", nowIso) }) };
    case "unknown":
      return d.verifyingUntil !== null
        ? { role: "alert", tone: "warn", text: fillP10(COPY.unknown, { time: timeIn(d.verifyingUntil, tz, nowIso) }) }
        : { role: "alert", tone: "warn", text: COPY.unknownChecked };
    case "failed":
      return { role: "status", tone: "muted", text: COPY.failed };
    case "discarded":
      return { role: "status", tone: "muted", text: COPY.discarded };
    case "expired":
      return { role: "status", tone: "muted", text: COPY.expired };
    case "removed":
      return { role: "status", tone: "muted", text: COPY.removed };
    default:
      return null;
  }
}

/** What the editor was doing when a refusal came back (P10 fixer ui-7). */
export type EditorAction = "save" | "rewrite" | "discard" | "resolve" | "new_from_text";

/** P10 fixer ui-7: the banner (role="alert") of a failed editor action, in that action's words. Nothing was being sent here,
 *  so this never says the send dialog's "Not sent: … Nothing was posted." (the editor never calls the send route).
 *  `readingOff` is the page's own fact (a Rewrite refused as "off" while reading is paused says so). */
export function editorFailureBanner(action: EditorAction, status: number, body: Record<string, unknown>, tz: string, nowIso: string,
  readingOff: boolean): ReplyBanner {
  const code = typeof body.error === "string" ? body.error : "";
  const warn = (text: string): ReplyBanner => ({ role: "alert", tone: "warn", text });
  if (status === 409 && code === "too_early") {
    const until = typeof body.until === "string" ? body.until : null;
    return warn(fillP10(COPY.tooEarly, { time: timeIn(until, tz, nowIso) }));
  }
  if (status === 409 && code === "already_posted") return { role: "alert", tone: "ok", text: COPY.alreadyPosted };
  if (status === 404) return { role: "alert", tone: "danger", text: COPY.notFound };
  // "Start a new draft with this text" is a create: its refusals (from_draft, deleted, author_optout, not_reading, off …).
  if (action === "new_from_text" && (status === 409 || status === 429)) return warn(createRefusalText(status === 429 ? "rate_limited" : code));
  if (status === 409 && (code === "conflict" || code === "busy" || code === "not_unknown")) return warn(COPY.stale);
  if (status === 409 && code === "not_installed") return warn(SLACK_P10_COPY.settings.notInstalled);
  if (action === "rewrite" && status === 409 && code === "off") {
    return warn(readingOff ? fillP10(COPY.rewriteFailed, { reason: COPY.reasons.reading_off }) : REPLY_UI_COPY.off);
  }
  // Create and Rewrite share the create bucket (C49).
  if (action === "rewrite" && status === 429) return warn(REPLY_UI_COPY.cap);
  return { role: "alert", tone: "danger", text: REPLY_UI_COPY.failed };
}

/** A send / review refusal in words. */
export function refusalText(reason: SendRefusal | string): string {
  switch (reason) {
    case "send_off":
      return COPY.sendOff;
    case "reading_off":
      return COPY.readingOff;
    case "stale":
    case "text_changed":
    case "not_canonical":
    case "lost_race":
      return COPY.stale;
    case "not_found":
    case "target":
      return COPY.notFound;
    case "placeholders":
      return COPY.placeholdersUnnamed;
    case "token_missing":
    case "token_mismatch":
    case "token_revoked":
      return fillP10(COPY.backToDraft, { reason: sendReasonText(reason) });
    case "unknown_status":
      return COPY.unknownChecked;
    default:
      return fillP10(COPY.backToDraft, { reason: COPY.sendReasons.other });
  }
}

/** What the send route answered, as one banner (RU05 / RU08). */
export type SendAnswer =
  | { kind: "sent"; postedTs: string; permalink: string | null }
  | { kind: "in_flight" }
  | { kind: "back_to_draft"; reason: string; version: number }
  | { kind: "unknown"; reason: string }
  | { kind: "needs_ack"; blockers: ReplyBlocker[] }
  | { kind: "refused"; reason: string }
  | { kind: "error" };

/** The route's JSON (status code + body) as a SendAnswer; anything unexpected is an error. */
export function parseSendAnswer(status: number, body: unknown): SendAnswer {
  const b = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status === 200 && b.kind === "sent" && typeof b.postedTs === "string") {
    return { kind: "sent", postedTs: b.postedTs, permalink: typeof b.permalink === "string" ? b.permalink : null };
  }
  if (status === 202 && b.kind === "in_flight") return { kind: "in_flight" };
  if (status === 200 && b.kind === "back_to_draft" && typeof b.reason === "string" && typeof b.version === "number") {
    return { kind: "back_to_draft", reason: b.reason, version: b.version };
  }
  if (status === 200 && b.kind === "unknown") return { kind: "unknown", reason: typeof b.reason === "string" ? b.reason : "unknown" };
  if (status === 409 && b.error === "needs_ack" && Array.isArray(b.blockers)) {
    return { kind: "needs_ack", blockers: b.blockers.filter((x): x is ReplyBlocker => typeof x === "string" && isBlocker(x)) };
  }
  if (status === 409 && b.error === "refused" && typeof b.reason === "string") return { kind: "refused", reason: b.reason };
  if (status === 404) return { kind: "refused", reason: "not_found" };
  return { kind: "error" };
}

/** The send's answer as the dialog's (and the card's) banner. */
export function sendAnswerBanner(a: SendAnswer, tz: string, nowIso: string): ReplyBanner {
  switch (a.kind) {
    case "sent":
      return { role: "status", tone: "ok", text: fillP10(COPY.sent, { time: timeIn(nowIso, tz, nowIso) }) };
    case "in_flight":
      return { role: "status", tone: "progress", text: COPY.sending };
    case "back_to_draft":
      return { role: "alert", tone: "warn", text: fillP10(COPY.backToDraft, { reason: sendReasonText(a.reason) }) };
    case "unknown": {
      // P10 fixer ui-2: no check has run yet. DD checks Slack (read-only, three times) until about now + the horizon, so the
      // answer says that (COPY.unknown), never unknownChecked's "DD didn't find it".
      const now = Date.parse(nowIso);
      const until = Number.isFinite(now) ? new Date(now + P10_LIMITS.replyVerifyHorizonMs).toISOString() : null;
      return { role: "alert", tone: "warn", text: fillP10(COPY.unknown, { time: timeIn(until, tz, nowIso) }) };
    }
    case "needs_ack":
      return { role: "alert", tone: "warn", text: fillP10(COPY.changedSinceReview, { list: blockerWords(a.blockers) }) };
    case "refused":
      return { role: "alert", tone: "danger", text: refusalText(a.reason) };
    default:
      return { role: "alert", tone: "danger", text: COPY.notFound };
  }
}

const BLOCKERS: readonly ReplyBlocker[] = ["placeholders", ...REPLY_ACKABLE];
export const isBlocker = (x: string): x is ReplyBlocker => (BLOCKERS as readonly string[]).includes(x);

/** "a, b and c" of the blockers in words (the DM card's reasons, reused). */
export function blockerWords(bs: readonly ReplyBlocker[]): string {
  const words = bs.map((b) => COPY.cardDdReasons[b]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The checkbox line for one ackable blocker (acks.*). */
export const ackText = (b: Exclude<ReplyBlocker, "placeholders">): string => COPY.acks[b];

/** Every blocker the send needs acknowledged, in order, with the ones the dialog has ticked (RU08). Placeholders are never
 *  ackable: a review that names them shows the "Fill in" line and no Send. */
export function dialogState(blockers: readonly ReplyBlocker[], acks: readonly ReplyBlocker[]): { ackable: Exclude<ReplyBlocker, "placeholders">[];
  hardStop: boolean; ready: boolean } {
  const ackable = blockers.filter((b): b is Exclude<ReplyBlocker, "placeholders"> => b !== "placeholders");
  const hardStop = blockers.includes("placeholders");
  return { ackable, hardStop, ready: !hardStop && ackable.every((b) => acks.includes(b)) };
}

/** The editor's switches (v1.1 product-15): while the textarea differs from the stored text, Send and Rewrite wait for Save. */
export function editorControls(d: Pick<ReplyPageDraft, "status" | "canEdit" | "canSend">, dirty: boolean, busy: boolean):
  { canSave: boolean; canSend: boolean; canRewrite: boolean; canDiscard: boolean; saveFirst: boolean } {
  const rewritable = d.status === "draft" || d.status === "generation_failed";
  return {
    canSave: d.canEdit && dirty && !busy,
    canSend: d.canSend && !dirty && !busy,
    canRewrite: rewritable && !dirty && !busy,
    canDiscard: rewritable && !busy,
    saveFirst: dirty && (d.canSend || rewritable)
  };
}

/** v1.1 product-15: Copy takes the textarea's text while it differs from the stored text, else the stored text. */
export function textToCopy(stored: string | null, current: string): string {
  return current !== (stored ?? "") ? current : stored ?? "";
}

/** v1.1 product-16: the status label of a message's draft wherever a row shows it (catch-up, Needs Attention); null for the
 *  statuses with no label (closed ones other than sent), where the row offers "Draft reply" again. */
export function replyStatusLabel(status: ReplyStatus, sentAt: string | null, tz: string, nowIso: string): string | null {
  const labels = COPY.statusLabels;
  switch (status) {
    case "generating":
    case "draft":
    case "generation_failed":
    case "sending":
    case "unknown":
      return labels[status];
    case "sent":
      return fillP10(labels.sent, { time: formatInZone(sentAt, tz, "datetime", nowIso) });
    default:
      return null;
  }
}

/** What focus can go back to (an element: the opener button or a status region with tabIndex -1). */
export interface FocusTarget { focus(): void; readonly isConnected: boolean }

/** P10 fixer ui-6: where focus goes when the send dialog closes: the button that opened it while it is still in the page
 *  (Cancel, Escape, an outside click, a refusal the draft stays a draft after), else the page's status region (the draft
 *  left `draft`, so its Send button is gone); null when neither is there. */
export function closeFocusTarget(opener: FocusTarget | null, fallback: FocusTarget | null): FocusTarget | null {
  if (opener !== null && opener.isConnected) return opener;
  if (fallback !== null && fallback.isConnected) return fallback;
  return null;
}

/** sha256 hex of the exact text the dialog shows, NFC (the send binds to it, RS03): crypto.subtle in the browser. */
export async function sha256HexOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.normalize("NFC"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
