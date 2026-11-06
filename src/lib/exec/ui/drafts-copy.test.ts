import { describe, expect, it } from "vitest";

import {
  ATTENTION_REASON,
  BLOCKER_COPY,
  CLONE_CODE_SENTENCE,
  CLONE_CODES,
  codeSentence,
  draftChipLabel,
  factsBanner,
  FLAG_WORDS,
  flagsBanner,
  GENERATION_ERRORS,
  GENERATION_FAILED_SENTENCE,
  REASON_WORDS,
  reasonWords,
  RECIPIENT_ERRORS,
  recipientEntry,
  ROUTE_CODE_SENTENCE,
  SEND_TOKEN_REASON_WORDS,
  UNSAFE_CONSTRUCT_WORDS
} from "@/components/exec/drafts/copy";
import { lastErrorNotice } from "@/components/exec/drafts/banner";
import { errorLines, outcomeOf } from "@/components/exec/drafts/panel-logic";
import { draftView } from "../__tests__/drafts-ui-fixtures";
import type { InsertSafeProblem } from "@/lib/exec/drafts-doc";
import type {
  DraftAttention,
  DraftErrorCode,
  EaReadinessReason,
  FactsStatus,
  GenerationError,
  GenerationFlag,
  ReviewBlocker,
  SendTokenReason,
  SendUnavailable
} from "@/lib/exec/drafts-types";
import { GENERATION_FLAGS, REVIEW_BLOCKERS } from "@/lib/exec/drafts-types";
import type { RecipientError } from "@/lib/exec/recipients";

// UI12 (P4 contract §5.11, §3.13.4): every code, reason, banner and flag has
// its one fixed sentence. The lists below are typed `Record<Union, true>`, so
// a member added to an exported union without being listed here fails the
// type-check, and a listed member without copy fails the test.

const all = <K extends string>(r: Record<K, true>): K[] => Object.keys(r) as K[];

const DRAFT_ERROR_CODES = all<DraftErrorCode>({
  not_found: true, forbidden: true, bad_request: true, invalid: true, drafts_off: true, send_off: true, drafts_unavailable: true,
  send_unavailable: true, rate_limited: true, version_conflict: true, state_conflict: true, review_required: true, review_expired: true,
  acks_missing: true, recipients_blocked: true, placeholders: true, empty_body: true, unsafe_markup: true, instruction_required: true,
  subject_required: true, thread_unavailable: true, mailbox_problem: true, audit_unavailable: true, unavailable: true, hold: true,
  sent_copy_found: true
});
const EA_REASONS = all<EaReadinessReason>({
  no_pin: true, multiple_principals: true, token_missing: true, base_url_missing: true, clone_unreachable: true, cl2_missing: true,
  cl2_not_ready: true, me_failed: true, me_no_auth: true, not_scoped: true, wrong_scopes: true, wrong_accounts: true, token_expired: true
});
const SEND_UNAVAILABLE = all<SendUnavailable>({ ...Object.fromEntries(EA_REASONS.map((r) => [r, true])), send_off: true, clone_send_off: true, send_token: true } as Record<SendUnavailable, true>);
const SEND_TOKEN_REASONS = all<SendTokenReason>({ token_missing: true, malformed: true, not_scoped: true, wrong_scopes: true, wrong_accounts: true, token_expired: true });
const RECIPIENT_CODES = all<RecipientError>({
  empty_to: true, invalid_address: true, own_address: true, no_reply_address: true, restricted_recipient: true, too_many: true,
  not_allowed: true, to_not_derived: true, bcc_on_reply: true, from_mismatch: true, sender_mismatch: true, reply_to_restricted: true,
  facts_recipient: true
});
const GENERATION_ERROR_LIST = all<GenerationError>({
  declined: true, truncated: true, invalid_output: true, budget: true, input_too_large: true, thread_unavailable: true, restricted: true,
  model_error: true, timeout: true, stale: true, stopped: true
});
const FLAGS = all<GenerationFlag>({
  unexpected_url: true, unexpected_email: true, unexpected_phone: true, unexpected_amount: true, unexpected_number: true,
  other_client_name: true, teammate_name: true
});
const BLOCKERS = all<ReviewBlocker>({
  already_replied: true, newer_inbound: true, reply_scheduled: true, legacy_draft_pending: true, opened_in_outlook: true,
  changed_in_outlook: true, recipients_changed: true, reply_to_present: true, placeholder_in_outlook: true, thread_unavailable: true,
  facts_outside_client: true, unexpected_content: true
});
const ATTENTION = all<DraftAttention>({
  unknown: true, sent_mismatch: true, gone_unconfirmed: true, outlook_changed: true, generation_failed: true, restricted: true, stale_link: true
});
const CONSTRUCTS = all<InsertSafeProblem>({
  script_tag: true, frame_tag: true, object_tag: true, form_tag: true, base_tag: true, meta_tag: true, link_tag: true,
  event_attribute: true, script_url: true
});
const FACTS = all<FactsStatus>({ used: true, none: true, not_matched: true, medium_confidence: true, unavailable: true, recipients_outside_client: true });

/** Every code drafts-state.ts / the routes write into an answer or last_error_code (§2.6, §3.12, T07, T25, T51, T52, T57, C71). */
const SECTION_2_6_CODES = [
  "ea_auth", "send_disabled", "mailbox_not_connected", "bad_request", "thread_not_found", "account_not_found", "clone_anomaly",
  "not_in_registry", "gone", "outlook_changed", "changed", "already_sending", "already_sent", "sent_externally", "parent_missing",
  "idempotency_mismatch", "throttled", "mailbox_reconnect", "graph_error", "clone_not_ready", "timeout", "clone_error", "transport",
  "outcome_unknown", "outlook_not_found", "timeout_nothing_sent", "accepted", "recreate_failed", "outlook_unknown",
  "outlook_unknown_restricted", "outlook_reappeared", "expired_idle", "generation_stopped",
  ...GENERATION_ERROR_LIST.map((c) => `generation_${c}`)
];

// Words the mail service could put in an answer: none of DD's sentences repeats clone text.
const CLONE_TEXT = /graph|error:|exception|stack|odata|http\s?\d{3}|\{|\}/i;

describe("UI12: the copy tables", () => {
  it("every DraftErrorCode has its route sentence, matching §3.13.4", () => {
    for (const code of DRAFT_ERROR_CODES) {
      expect(ROUTE_CODE_SENTENCE[code], code).toBeTruthy();
      expect(codeSentence(code), code).toBeTruthy();
    }
    expect(Object.keys(ROUTE_CODE_SENTENCE).sort()).toEqual([...DRAFT_ERROR_CODES].sort());
    expect(codeSentence("not_found")).toBe("This draft doesn't exist or isn't yours.");
    expect(codeSentence("version_conflict")).toBe("This draft changed elsewhere. Your last edit wasn't saved.");
    expect(codeSentence("state_conflict", { status: "sent" })).toBe("This draft moved on (now sent). The page has been refreshed.");
    expect(codeSentence("drafts_unavailable", { reason: "token_expired" })).toBe("Drafts are unavailable: the drafting key has expired.");
    expect(codeSentence("send_unavailable", { reason: "clone_send_off" })).toBe("Sending is unavailable: the mail service hasn't switched sending on for your mailbox.");
    expect(codeSentence("unsafe_markup", { constructs: ["script_tag", "event_attribute"] })).toBe(
      "The text contains something the mail service refuses: a script tag and a word starting with 'on' followed by '='. Rephrase it."
    );
    expect(codeSentence("bad_request", { fromClone: true })).toBe("The mail service refused the request. The team has been told.");
    expect(codeSentence("hold")).toBe("An earlier draft for this email may already have been sent. Check your Sent Items in Outlook, then confirm.");
  });

  it("every §2.6 code has its fixed sentence", () => {
    for (const code of SECTION_2_6_CODES) expect(codeSentence(code), code).toBeTruthy();
    for (const code of CLONE_CODES) expect(CLONE_CODE_SENTENCE[code], code).toBeTruthy();
    expect(codeSentence("throttled", { retryAfterSec: 12 })).toBe("Outlook is busy. Try again in 12 s.");
    expect(codeSentence("transport")).toBe("We lost the connection while sending. We can't tell yet whether it went out. Don't send it again.");
    expect(codeSentence("generation_timeout")).toBe("Regenerating failed: Drafting took too long. Try again. Your previous text is unchanged.");
    expect(codeSentence("no_such_code")).toBeNull();
  });

  it("every generation error has a sentence", () => {
    for (const code of GENERATION_ERROR_LIST) expect(GENERATION_FAILED_SENTENCE[code], code).toBeTruthy();
    expect([...GENERATION_ERRORS].sort()).toEqual([...GENERATION_ERROR_LIST].sort());
  });

  it("every RecipientError has its entry, filled with DD's address (never a name) and the client", () => {
    for (const code of RECIPIENT_CODES) expect(recipientEntry(code, "x@acme.com"), code).toBeTruthy();
    expect([...RECIPIENT_ERRORS].sort()).toEqual([...RECIPIENT_CODES].sort());
    expect(recipientEntry("invalid_address", "x@@acme")).toBe("x@@acme isn't a valid email address.");
    expect(recipientEntry("not_allowed", "new@acme.com")).toBe("new@acme.com isn't one of the people you can add here. Write to someone new from Outlook.");
    expect(recipientEntry("facts_recipient", "x@other.com", "Acme Dental")).toBe(
      "This draft uses internal status for Acme Dental, and x@other.com isn't at Acme Dental. Remove them, or regenerate to draft without client status."
    );
    expect(recipientEntry("bcc_on_reply", null)).toBe("Replies can't have Bcc.");
    const lines = errorLines(422, { error: "recipients_blocked", errors: [{ code: "own_address", address: "me@scaledai.org" }, { code: "too_many", address: null }] });
    expect(lines).toEqual(["Some recipients can't be used:", "me@scaledai.org is your own address.", "More than 20 recipients."]);
  });

  it("every EaReadinessReason and SendUnavailable reason has its words; the send token's reasons too", () => {
    for (const r of [...EA_REASONS, ...SEND_UNAVAILABLE, "drafts_off", "mailbox_problem"]) {
      expect(REASON_WORDS[r as keyof typeof REASON_WORDS], r).toBeTruthy();
      expect(reasonWords(r)).not.toBe(r);
    }
    for (const r of SEND_TOKEN_REASONS) expect(SEND_TOKEN_REASON_WORDS[r], r).toBeTruthy();
    expect(reasonWords("no_pin")).toBe("your mailbox isn't linked to the assistant");
    expect(reasonWords("send_token")).toBe("the sending key is missing or wrong");
  });

  it("every FactsStatus: the three withheld ones get a banner, the rest none", () => {
    for (const s of FACTS) {
      const b = factsBanner(s, "Acme Dental");
      if (s === "medium_confidence" || s === "unavailable" || s === "recipients_outside_client") expect(b, s).toMatch(/^No client status used: /);
      else expect(b, s).toBeNull();
    }
    expect(factsBanner("recipients_outside_client", "Acme Dental")).toBe("No client status used: a recipient isn't at Acme Dental.");
  });

  it("every GenerationFlag has its words, joined with commas and 'and'", () => {
    for (const f of FLAGS) expect(FLAG_WORDS[f], f).toBeTruthy();
    expect([...GENERATION_FLAGS].sort()).toEqual([...FLAGS].sort());
    expect(flagsBanner([])).toBeNull();
    expect(flagsBanner(["unexpected_url", "unexpected_email", "teammate_name"])).toBe(
      "Check before sending: the assistant added a link, an email address and a teammate's name that weren't in your instruction or the client facts."
    );
  });

  it("every review blocker, unsafe construct and attention reason has its copy", () => {
    for (const b of BLOCKERS) expect(BLOCKER_COPY[b], b).toBeTruthy();
    expect([...REVIEW_BLOCKERS].sort()).toEqual([...BLOCKERS].sort());
    for (const c of CONSTRUCTS) expect(UNSAFE_CONSTRUCT_WORDS[c], c).toBeTruthy();
    for (const a of ATTENTION) expect(ATTENTION_REASON[a], a).toBeTruthy();
    expect(ATTENTION_REASON).toEqual({
      unknown: "Outcome unknown",
      sent_mismatch: "Sent copy didn't match",
      gone_unconfirmed: "Checking whether it was sent",
      outlook_changed: "Changed in Outlook",
      generation_failed: "Drafting failed",
      restricted: "Restricted thread",
      stale_link: "Outlook copy is older"
    });
  });

  it("the email list chips (L15)", () => {
    expect(draftChipLabel("generating")).toBe("Drafting…");
    expect(draftChipLabel("draft")).toBe("Draft ready");
    expect(draftChipLabel("saved")).toBe("Draft ready");
    expect(draftChipLabel("unknown")).toBe("Check Sent Items");
    for (const s of ["saving", "sending", "sent_pending", "sent", "gone", "discarded", "generation_failed"]) expect(draftChipLabel(s)).toBeNull();
  });

  it("no sentence contains clone text", () => {
    const sentences = [
      ...Object.values(ROUTE_CODE_SENTENCE),
      ...Object.values(CLONE_CODE_SENTENCE),
      ...Object.values(GENERATION_FAILED_SENTENCE),
      ...Object.values(REASON_WORDS),
      ...Object.values(FLAG_WORDS),
      ...Object.values(BLOCKER_COPY),
      ...RECIPIENT_CODES.map((c) => recipientEntry(c, "x@acme.com"))
    ];
    for (const s of sentences) expect(s, s).not.toMatch(CLONE_TEXT);
    // An answer's free-text fields are never shown: only the code picks the sentence.
    const lines = errorLines(409, { error: "state_conflict", status: "sent", detail: "Graph said: ErrorItemNotFound {stack}", message: "clone text" });
    expect(lines).toEqual(["This draft moved on (now sent). The page has been refreshed."]);
    expect(errorLines(502, { error: "something_new", detail: "raw clone text" })).toEqual(["Couldn't reach a service this needs. Try again shortly."]);
  });

  it("a mapped save failure is said once (ui-5): the banner states the view's lastError, the answer adds nothing; a stored throttled names no wait", () => {
    const view = draftView({ lastError: { code: "throttled", at: "2026-11-06T12:00:00.000Z" } });
    const out = outcomeOf("save", 200, { status: "draft", code: "throttled", retryAfterSec: 120, view });
    expect(out.lines).toEqual([]);
    expect(lastErrorNotice(view)).toBe("Outlook is busy. Try again shortly.");
    for (const code of ["graph_error", "parent_missing", "mailbox_reconnect"]) {
      const v = draftView({ lastError: { code, at: "2026-11-06T12:00:00.000Z" } });
      expect(outcomeOf("save", 200, { status: "draft", code, view: v }).lines, code).toEqual([]);
      expect(lastErrorNotice(v), code).toBe(codeSentence(code));
    }
    // A code the view doesn't record still gets its line (with the answer's wait).
    expect(outcomeOf("save", 200, { status: "draft", code: "throttled", retryAfterSec: 120, view: draftView() }).lines).toEqual(["Outlook is busy. Try again in 120 s."]);
  });

  it("a clone bad_request reads as the clone's (ui-6): in a 2xx answer's code and as a stored lastError", () => {
    const clone = "The mail service refused the request. The team has been told.";
    expect(outcomeOf("save", 200, { status: "draft", code: "bad_request", view: draftView() }).lines).toEqual([clone]);
    expect(lastErrorNotice(draftView({ lastError: { code: "bad_request", at: "2026-11-06T12:00:00.000Z" } }))).toBe(clone);
    // DD's own 400 keeps its own sentence.
    expect(errorLines(400, { error: "bad_request" })).toEqual([ROUTE_CODE_SENTENCE.bad_request]);
  });
});
