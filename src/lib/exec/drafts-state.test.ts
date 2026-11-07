import { describe, expect, it } from "vitest";

import { checkDraftRow } from "@/lib/exec/__tests__/fake-drafts-db";
import { CloneEaError, type CloneDraftRead, type CloneEaRoute, type CloneErrorBody, type CloneReadBack, type CloneRegistryView } from "@/lib/exec/clone-ea-types";
import {
  applyDraftPatch,
  assertKeyShape,
  auditCode,
  canOfferNewReply,
  capabilitiesFor,
  changedSinceSaved,
  checkedPatch,
  closePurgedCreate,
  computeReviewBlockers,
  deleteKey,
  draftAttention,
  giveUpSaving,
  graphIdFp,
  guard,
  hasLink,
  isActiveDraft,
  isStaleLink,
  isTerminalStatus,
  linkReplacement,
  mapCreateResult,
  mapDeleteResult,
  mapGetResult,
  mapRecreateResult,
  mapReplayResult,
  mapSendResult,
  mirrorRegistry,
  newKeyNonce,
  nextCheckAt,
  priorStatusOf,
  resolveRecreateByGet,
  reviewIsValid,
  saveKey,
  saveOutcomeUnknown,
  sendKey,
  terminalPatch,
  type CloneAnswer,
  type DraftAction,
  type GuardContext,
  type ReviewFacts,
  type Transition
} from "@/lib/exec/drafts-state";
import { DRAFT_COLUMNS } from "@/lib/exec/drafts-store";
import {
  DRAFT_LIMITS,
  DRAFT_STATUSES,
  REVIEW_BLOCKERS,
  type CloneDraftStatus,
  type DraftErrorCode,
  type ExecDraftRow,
  type ExecDraftStatus,
  type ResolveAction,
  type ReviewBlocker
} from "@/lib/exec/drafts-types";
import type { HisMessage, PrincipalMailThread } from "@/lib/exec/email-types";
import { NonRetryableError } from "@/lib/exec/types";

// The pure state machine (contract §2.4-§2.6, §3.6): ST01-ST20. Every
// Transition a test produces is also run through ST16's CHECK oracle
// (fake-drafts-db's checkDraftRow, the §2.1 subset) against its source row.

const NOW = new Date("2026-11-06T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const HEX = (c: string) => c.repeat(64);
const GRAPH = "AAMkAGI2THVSAAA=";
const ID = "ed_0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function base(over: Partial<ExecDraftRow> = {}): ExecDraftRow {
  return {
    id: ID, principalId: "ep_1", accountId: "acc_1", kind: "reply", origin: "web",
    status: "draft", priorStatus: null, version: 2, savedVersion: null, generationSeq: 1,
    threadId: "th_1", parentMessageId: "m_1", replyMode: "reply",
    threadSubject: "Renewal", replyCandidates: null, threadAddresses: ["a@client.com"],
    toRecipients: [{ address: "a@client.com", name: "Ann" }], ccRecipients: [], bccRecipients: [],
    subject: null, bodyDoc: { type: "doc", content: [] } as unknown as ExecDraftRow["bodyDoc"], bodyHtml: "<p>Hi</p>", bodyText: "Hi",
    instruction: "say yes", noteForMitchell: null, placeholders: [], reviewRecipients: null, recipientsSig: HEX("1"),
    screenHashes: [], screenTruncated: false, screenedPolicyHash: HEX("2"),
    renderNonce: "abcdefabcdefabcdef012345", model: null, usage: null, generationError: null, generationFlags: [],
    factsStatus: "none", clientId: null, generatedAt: at(-10 * MIN),
    outlookGraphId: null, internetMessageId: null, conversationId: null, webLink: null,
    contentHash: null, observedContentHash: null, reviewHash: null, reviewAt: null, reviewBlockers: [],
    confirmHash: null, saveAttemptKey: null, saveVersion: null, saveTimezone: null, saveIfContentHash: null,
    saveStartedAt: null, discardAttemptKey: null, discardStartedAt: null, sendAttemptKey: null, sendStartedAt: null,
    sendAcceptedAt: null, sentAt: null, sentAuditId: null,
    sentMismatch: false, unverified: false, goneUnconfirmed: false, signatureSkipped: false, outlookEdited: false,
    restrictedPurged: false, usesPrivateRefs: false, cloneFlags: [], ownerResolution: null, openedInOutlookAt: null,
    lastErrorCode: null, lastErrorAt: null, nextCheckAt: null, checkCount: 0, goneAt: null,
    createdAt: at(-20 * MIN), updatedAt: at(-5 * MIN), terminalAt: null, contentPurgedAt: null, expiresAt: null,
    instructionBy: "owner",
    chatMessageId: null,
    ...over
  };
}

const LINK = { outlookGraphId: GRAPH, webLink: "https://outlook.office.com/x", contentHash: HEX("c"), observedContentHash: HEX("c"), internetMessageId: "<id@x>" };
const SEND = { sendAttemptKey: `${ID}:v2:send:nonce1234567890ab`, sendStartedAt: at(-31 * MIN), confirmHash: HEX("c") };

/** A row of each status with the columns its CHECKs need. */
function rowFor(status: ExecDraftStatus, over: Partial<ExecDraftRow> = {}): ExecDraftRow {
  switch (status) {
    case "generating": return base({ status, ...over });
    case "generation_failed": return base({ status, generationError: "declined", ...over });
    case "draft": return base({ status, ...over });
    case "saving": return base({ status, saveAttemptKey: `${ID}:v2:save:nonce1234567890ab`, saveVersion: 2, saveStartedAt: at(-MIN), saveTimezone: "UTC", nextCheckAt: at(5 * MIN), ...over });
    case "saved": return base({ status, ...LINK, savedVersion: 2, reviewHash: HEX("c"), reviewAt: at(-MIN), ...over });
    case "sending": return base({ status, ...LINK, savedVersion: 2, ...SEND, sendStartedAt: at(-MIN), nextCheckAt: at(2 * MIN), ...over });
    case "sent_pending": return base({ status, ...LINK, savedVersion: 2, ...SEND, sendAcceptedAt: at(-30 * MIN), nextCheckAt: at(MIN), ...over });
    case "unknown": return base({ status, ...LINK, savedVersion: 2, ...SEND, nextCheckAt: at(MIN), ...over });
    case "sent": return base({ status, ...LINK, savedVersion: 2, ...SEND, sentAt: at(-30 * MIN), terminalAt: at(-30 * MIN), expiresAt: at(180 * 1440 * MIN), ...over });
    case "sent_external": return base({ status, ...LINK, savedVersion: 2, terminalAt: at(-30 * MIN), expiresAt: at(180 * 1440 * MIN), ...over });
    case "gone": return base({ status, ...LINK, savedVersion: 2, goneUnconfirmed: true, goneAt: at(-MIN), terminalAt: at(-MIN), expiresAt: at(180 * 1440 * MIN), nextCheckAt: at(MIN), ...over });
    case "discarding": return base({ status, ...LINK, savedVersion: 2, priorStatus: "saved", discardAttemptKey: `${ID}:g0123456789abcdef:delete:nonce1234567890ab`, discardStartedAt: at(-MIN), nextCheckAt: at(5 * MIN), ...over });
    case "discarded": return base({ status, terminalAt: at(-30 * MIN), expiresAt: at(180 * 1440 * MIN), ...over });
  }
}

function readBack(over: Partial<CloneReadBack> = {}): CloneReadBack {
  return {
    live: true, graphId: GRAPH, status: "saved", kind: "reply", accountId: "acc_1", threadId: "th_1", parentMessageId: "m_1",
    replaces: null, changeKey: "ck", contentHash: HEX("d"), internetMessageId: "<new@x>", conversationId: "conv", webLink: "https://outlook.office.com/y",
    isDraft: true, lastModified: at(-MIN), sentAt: null, from: null, sender: null, replyTo: [], to: [{ address: "a@client.com", name: "Ann" }], cc: [], bcc: [],
    subject: "Re: Renewal", bodyHtml: "<p>Hi</p>", attachments: [], flags: [], ...over
  };
}
function registryView(status: CloneDraftStatus, over: Partial<CloneRegistryView> = {}): CloneRegistryView {
  return { live: false, graphId: GRAPH, status, flags: [], internetMessageId: null, webLink: null, verifiedAt: null, ...over };
}

const body = (error: string, over: Partial<CloneErrorBody> = {}): CloneErrorBody =>
  ({ error, detail: null, draftStatus: null, graphStatus: null, graphCode: null, replacedBy: null, ...over });
function cloneErr(route: CloneEaRoute, status: number | null, error: string | null, over: Partial<CloneErrorBody> = {}, extra: { code?: string; replay?: boolean } = {}): CloneEaError {
  return new CloneEaError({ route, status, body: error === null ? null : body(error, over), ...extra });
}
const ok = <T,>(value: T, replay = false): CloneAnswer<T> => ({ ok: true, value, replay });
const fail = <T,>(error: CloneEaError): CloneAnswer<T> => ({ ok: false, error });
const NO_ANSWER: CloneAnswer<never> = { ok: false, noAnswer: true };

/** ST16's oracle on every transition the tests produce: the patch, applied to its source row, satisfies §2.1's CHECKs. */
const produced: { label: string; row: ExecDraftRow; t: Transition }[] = [];
function snakeOf(row: ExecDraftRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(DRAFT_COLUMNS)) out[column] = row[field as keyof ExecDraftRow];
  return out;
}
function tx(label: string, row: ExecDraftRow, t: Transition): Transition {
  produced.push({ label, row, t });
  expect(t.patch.status ?? row.status, `${label}: patch status matches to`).toBe(t.to);
  return t;
}
const isTransition = (x: unknown): x is Transition => typeof x === "object" && x !== null && "to" in x && "patch" in x;

const CTX: GuardContext = { now: NOW, draftsOn: true, sendOn: true, draftsReady: true, sendReady: true, restricted: false, checkedOutlook: true, sentCopy: "not_found" };
const ACTIONS: DraftAction[] = ["edit", "regenerate", "save", "review", "send", "discard", "delete_restricted", "outlook_opened",
  "resolve:mark_sent", "resolve:not_sent_new_draft", "resolve:copy_to_new_draft", "resolve:keep_outlook_version", "resolve:check", "resolve:stop_generation"];
const verdict = (r: ReturnType<typeof guard>) => (r.ok ? "ok" : r.code);

// ---------------------------------------------------------------------------
// ST01-ST03
// ---------------------------------------------------------------------------

describe("ST01 isTerminalStatus / isActiveDraft", () => {
  it("equal §2.4 for all 13 statuses; gone is active only while unconfirmed", () => {
    const expected: Record<ExecDraftStatus, [boolean, boolean]> = {
      generating: [false, true], generation_failed: [false, true], draft: [false, true], saving: [false, true], saved: [false, true],
      sending: [false, true], sent_pending: [false, true], unknown: [false, true], sent: [true, false], sent_external: [true, false],
      gone: [true, false], discarding: [false, true], discarded: [true, false]
    };
    for (const s of DRAFT_STATUSES) {
      expect(isTerminalStatus(s), s).toBe(expected[s][0]);
      expect(isActiveDraft({ status: s, goneUnconfirmed: false }), s).toBe(expected[s][1]);
    }
    expect(isActiveDraft({ status: "gone", goneUnconfirmed: true })).toBe(true);
    expect(hasLink(rowFor("saved"))).toBe(true);
    expect(hasLink(rowFor("draft"))).toBe(false);
    expect(isStaleLink(rowFor("saved"))).toBe(false);
    expect(isStaleLink(rowFor("draft", { ...LINK, savedVersion: 1 }))).toBe(true);
    expect(isStaleLink(rowFor("draft", { ...LINK, savedVersion: null }))).toBe(true);
    expect(isStaleLink(rowFor("draft"))).toBe(false);
  });
});

describe("ST02 key formats", () => {
  it("are exact, and a 512-character graphId with '=' still yields a key of at most 128 characters without '='", () => {
    expect(saveKey(ID, 3, "nonce1234567890ab")).toBe(`${ID}:v3:save:nonce1234567890ab`);
    expect(sendKey(ID, 3, "nonce1234567890ab")).toBe(`${ID}:v3:send:nonce1234567890ab`);
    expect(graphIdFp(GRAPH)).toMatch(/^[0-9a-f]{16}$/);
    expect(graphIdFp(GRAPH)).toBe(graphIdFp(GRAPH));
    expect(graphIdFp(GRAPH)).not.toBe(graphIdFp(`${GRAPH}x`));
    const long = `${"A".repeat(500)}${"=".repeat(12)}`;
    const key = deleteKey(ID, long, "nonce1234567890ab");
    expect(key).toBe(`${ID}:g${graphIdFp(long)}:delete:nonce1234567890ab`);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).not.toContain("=");
    expect(() => assertKeyShape(key)).not.toThrow();
  });
  it("assertKeyShape refuses '=', a space and 129 characters", () => {
    expect(() => assertKeyShape("a=b")).toThrow(NonRetryableError);
    expect(() => assertKeyShape("a b")).toThrow(NonRetryableError);
    expect(() => assertKeyShape("a".repeat(129))).toThrow(NonRetryableError);
    expect(() => assertKeyShape("")).toThrow(NonRetryableError);
    expect(() => assertKeyShape("a".repeat(128))).not.toThrow();
    expect(() => assertKeyShape("A-z_0.9:x")).not.toThrow();
  });
});

describe("ST03 newKeyNonce", () => {
  it("is 16 base64url characters and consecutive calls differ", () => {
    const a = newKeyNonce();
    const b = newKeyNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// ST04 guard (table-driven)
// ---------------------------------------------------------------------------

describe("ST04 guard", () => {
  const baseline: Record<DraftAction, ExecDraftStatus[]> = {
    edit: ["generation_failed", "draft", "saved"],
    regenerate: ["generation_failed", "draft", "saved"],
    save: ["draft"],
    review: ["saved"],
    send: ["saved"],
    discard: ["generation_failed", "draft", "saved"],
    delete_restricted: [],
    outlook_opened: ["saved", "unknown", "sent_pending"],
    "resolve:mark_sent": ["unknown", "gone"],
    "resolve:not_sent_new_draft": ["unknown"],
    "resolve:copy_to_new_draft": ["gone"],
    "resolve:keep_outlook_version": [],
    "resolve:check": ["saved", "unknown", "sent_pending", "gone"],
    "resolve:stop_generation": ["generating"]
  };
  const rows: [string, DraftAction, ExecDraftRow, Partial<GuardContext>, "ok" | DraftErrorCode][] = [];
  for (const action of ACTIONS) {
    for (const s of DRAFT_STATUSES) rows.push([`${action} on ${s}`, action, rowFor(s), {}, baseline[action].includes(s) ? "ok" : "state_conflict"]);
  }
  const stale = rowFor("draft", { ...LINK, savedVersion: 1 });
  const changedDraft = rowFor("draft", { ...LINK, savedVersion: 1, lastErrorCode: "outlook_changed" });
  const changedSaved = rowFor("saved", { observedContentHash: HEX("e") });
  const held = rowFor("gone");
  const confirmed = rowFor("gone", { goneUnconfirmed: false, nextCheckAt: null });
  const reappeared = rowFor("gone", { goneUnconfirmed: false, nextCheckAt: null, lastErrorCode: "outlook_reappeared" });
  const fresh = rowFor("unknown", { sendStartedAt: at(-10 * MIN) });
  const freshFlag = rowFor("unknown", { sendStartedAt: at(-10 * MIN), cloneFlags: ["send_status_unknown"] });
  const oldFlag = rowFor("unknown", { cloneFlags: ["send_status_unknown"] });
  const noStart = rowFor("unknown", { sendStartedAt: null, sendAttemptKey: null, confirmHash: null });
  const variants: typeof rows = [
    // stale link
    ["stale link: edit", "edit", stale, {}, "ok"], ["stale link: regenerate", "regenerate", stale, {}, "ok"], ["stale link: save (T17)", "save", stale, {}, "ok"],
    ["stale link: discard (T37)", "discard", stale, {}, "ok"], ["stale link: open", "outlook_opened", stale, {}, "ok"], ["stale link: check", "resolve:check", stale, {}, "ok"],
    ["stale link: review", "review", stale, {}, "state_conflict"], ["stale link: keep", "resolve:keep_outlook_version", stale, {}, "state_conflict"],
    // changed in Outlook (C53)
    ["changed draft: keep", "resolve:keep_outlook_version", changedDraft, {}, "ok"], ["changed saved: keep", "resolve:keep_outlook_version", changedSaved, {}, "ok"],
    ["changed saved: check", "resolve:check", changedSaved, {}, "ok"], ["changed saved: save", "save", changedSaved, {}, "state_conflict"],
    ["unlinked draft with the code: keep", "resolve:keep_outlook_version", rowFor("draft", { lastErrorCode: "outlook_changed" }), {}, "state_conflict"],
    // restricted (C13), by context and by the row's flag
    ["restricted ctx saved: edit", "edit", rowFor("saved"), { restricted: true }, "not_found"],
    ["restricted ctx saved: review", "review", rowFor("saved"), { restricted: true }, "not_found"],
    ["restricted ctx saved: send", "send", rowFor("saved"), { restricted: true }, "not_found"],
    ["restricted ctx saved: discard", "discard", rowFor("saved"), { restricted: true }, "not_found"],
    ["restricted ctx saved: open", "outlook_opened", rowFor("saved"), { restricted: true }, "not_found"],
    ["restricted ctx saved: check", "resolve:check", rowFor("saved"), { restricted: true }, "not_found"],
    ["restricted ctx saved: delete", "delete_restricted", rowFor("saved"), { restricted: true }, "ok"],
    ["purged saved: delete", "delete_restricted", rowFor("saved", { restrictedPurged: true, toRecipients: [], threadSubject: null, threadAddresses: [], bodyDoc: null, bodyHtml: null, bodyText: null, instruction: null, recipientsSig: null, contentPurgedAt: at(-MIN) }), {}, "ok"],
    ["purged saved: edit", "edit", rowFor("saved", { restrictedPurged: true }), {}, "not_found"],
    ["restricted linked draft: delete", "delete_restricted", stale, { restricted: true }, "ok"],
    ["restricted linked draft: save", "save", stale, { restricted: true }, "not_found"],
    ["restricted DD-only draft: delete", "delete_restricted", rowFor("draft"), { restricted: true }, "not_found"],
    ["restricted DD-only draft: discard", "discard", rowFor("draft"), { restricted: true }, "not_found"],
    ["restricted unknown: check", "resolve:check", rowFor("unknown"), { restricted: true }, "ok"],
    ["restricted unknown: mark_sent", "resolve:mark_sent", rowFor("unknown"), { restricted: true }, "ok"],
    ["restricted unknown: not_sent", "resolve:not_sent_new_draft", rowFor("unknown"), { restricted: true }, "ok"],
    ["restricted unknown: copy", "resolve:copy_to_new_draft", rowFor("unknown"), { restricted: true }, "not_found"],
    ["restricted unknown: delete", "delete_restricted", rowFor("unknown"), { restricted: true }, "not_found"],
    ["restricted unknown: open", "outlook_opened", rowFor("unknown"), { restricted: true }, "not_found"],
    ["restricted gone: copy", "resolve:copy_to_new_draft", held, { restricted: true }, "not_found"],
    ["gone, already copied (data-7)", "resolve:copy_to_new_draft", rowFor("gone", { goneUnconfirmed: false, lastErrorCode: "copied" }), {}, "state_conflict"],
    ["restricted gone: mark_sent", "resolve:mark_sent", held, { restricted: true }, "not_found"],
    ["restricted gone: check", "resolve:check", held, { restricted: true }, "not_found"],
    ["restricted sent_pending: check", "resolve:check", rowFor("sent_pending"), { restricted: true }, "not_found"],
    ["restricted generating: stop", "resolve:stop_generation", rowFor("generating"), { restricted: true }, "not_found"],
    ["unrestricted saved: delete_restricted", "delete_restricted", rowFor("saved"), {}, "state_conflict"],
    // gone held / not held (C17, buildability-3)
    ["gone unconfirmed, not checked: copy", "resolve:copy_to_new_draft", held, { checkedOutlook: false }, "hold"],
    ["gone unconfirmed, not checked: mark_sent", "resolve:mark_sent", held, { checkedOutlook: false }, "hold"],
    ["gone unconfirmed, not checked: check", "resolve:check", held, { checkedOutlook: false }, "ok"],
    ["gone confirmed, not checked: copy", "resolve:copy_to_new_draft", confirmed, { checkedOutlook: false }, "hold"],
    ["gone confirmed, checked: copy", "resolve:copy_to_new_draft", confirmed, {}, "ok"],
    ["gone confirmed, checked: mark_sent", "resolve:mark_sent", confirmed, {}, "ok"],
    ["gone confirmed: check", "resolve:check", confirmed, {}, "state_conflict"],
    ["gone confirmed, unsupported + checked: copy", "resolve:copy_to_new_draft", confirmed, { sentCopy: "unsupported" }, "ok"],
    ["gone confirmed, unsupported + unchecked: copy", "resolve:copy_to_new_draft", confirmed, { sentCopy: "unsupported", checkedOutlook: false }, "hold"],
    ["gone reappeared: copy", "resolve:copy_to_new_draft", reappeared, {}, "state_conflict"],
    ["gone reappeared: mark_sent", "resolve:mark_sent", reappeared, {}, "state_conflict"],
    // unknown before / after 30 min (C68)
    ["unknown < 30 min: mark_sent", "resolve:mark_sent", fresh, {}, "hold"],
    ["unknown < 30 min: not_sent", "resolve:not_sent_new_draft", fresh, {}, "hold"],
    ["unknown < 30 min: check", "resolve:check", fresh, {}, "ok"],
    ["unknown < 30 min: open", "outlook_opened", fresh, {}, "ok"],
    ["unknown < 30 min: copy", "resolve:copy_to_new_draft", fresh, {}, "state_conflict"],
    ["unknown < 30 min + flag: mark_sent", "resolve:mark_sent", freshFlag, {}, "hold"],
    ["unknown < 30 min + flag: not_sent", "resolve:not_sent_new_draft", freshFlag, {}, "hold"],
    ["unknown >= 30 min + flag: mark_sent", "resolve:mark_sent", oldFlag, {}, "ok"],
    ["unknown >= 30 min + flag: not_sent", "resolve:not_sent_new_draft", oldFlag, {}, "ok"],
    ["unknown without send_started_at: mark_sent", "resolve:mark_sent", noStart, {}, "ok"],
    ["unknown without send_started_at: not_sent", "resolve:not_sent_new_draft", noStart, {}, "ok"],
    ["unknown >= 30 min, not checked: mark_sent", "resolve:mark_sent", rowFor("unknown"), { checkedOutlook: false }, "hold"],
    ["unknown >= 30 min, not checked: not_sent", "resolve:not_sent_new_draft", rowFor("unknown"), { checkedOutlook: false }, "hold"],
    ["unknown >= 30 min, sentCopy unset: mark_sent", "resolve:mark_sent", rowFor("unknown"), { sentCopy: undefined }, "ok"],
    ["unknown: send", "send", rowFor("unknown"), {}, "state_conflict"],
    // C76: a send in doubt never gets save / review / send from the same row
    ["flagged draft: save", "save", rowFor("draft", { cloneFlags: ["send_status_unknown"] }), {}, "state_conflict"],
    ["flagged saved: review", "review", rowFor("saved", { cloneFlags: ["send_status_unknown"] }), {}, "state_conflict"],
    ["flagged saved: send", "send", rowFor("saved", { cloneFlags: ["send_status_unknown"] }), {}, "state_conflict"],
    ["flagged saved: edit", "edit", rowFor("saved", { cloneFlags: ["send_status_unknown"] }), {}, "ok"],
    ["resolved draft: save", "save", rowFor("draft", { ownerResolution: "not_sent" }), {}, "state_conflict"],
    ["resolved saved: review", "review", rowFor("saved", { ownerResolution: "sent" }), {}, "state_conflict"],
    ["resolved saved: send", "send", rowFor("saved", { ownerResolution: "sent" }), {}, "state_conflict"],
    // send off / send readiness
    ["send off: send", "send", rowFor("saved"), { sendOn: false }, "send_off"],
    ["send off: review", "review", rowFor("saved"), { sendOn: false }, "send_off"],
    ["send off: save", "save", rowFor("draft"), { sendOn: false }, "ok"],
    ["send not ready: send", "send", rowFor("saved"), { sendReady: false }, "send_unavailable"],
    ["send not ready: review", "review", rowFor("saved"), { sendReady: false }, "send_unavailable"],
    ["send not ready: edit", "edit", rowFor("saved"), { sendReady: false }, "ok"],
    // readiness down (C24)
    ["not ready: regenerate", "regenerate", rowFor("draft"), { draftsReady: false }, "drafts_unavailable"],
    ["not ready: save", "save", rowFor("draft"), { draftsReady: false }, "drafts_unavailable"],
    ["not ready: review", "review", rowFor("saved"), { draftsReady: false }, "drafts_unavailable"],
    ["not ready: send", "send", rowFor("saved"), { draftsReady: false }, "drafts_unavailable"],
    ["not ready: discard linked", "discard", rowFor("saved"), { draftsReady: false }, "drafts_unavailable"],
    ["not ready: discard DD-only", "discard", rowFor("draft"), { draftsReady: false }, "ok"],
    ["not ready: discard failed", "discard", rowFor("generation_failed"), { draftsReady: false }, "ok"],
    ["not ready: edit", "edit", rowFor("draft"), { draftsReady: false }, "ok"],
    ["not ready: open", "outlook_opened", rowFor("saved"), { draftsReady: false }, "ok"],
    ["not ready: check", "resolve:check", rowFor("saved"), { draftsReady: false }, "drafts_unavailable"],
    ["not ready: mark_sent", "resolve:mark_sent", rowFor("unknown"), { draftsReady: false }, "ok"],
    ["not ready: not_sent", "resolve:not_sent_new_draft", rowFor("unknown"), { draftsReady: false }, "drafts_unavailable"],
    ["not ready: copy linked gone", "resolve:copy_to_new_draft", confirmed, { draftsReady: false }, "drafts_unavailable"],
    ["not ready: keep", "resolve:keep_outlook_version", changedDraft, { draftsReady: false }, "drafts_unavailable"],
    ["not ready: stop", "resolve:stop_generation", rowFor("generating"), { draftsReady: false }, "ok"],
    ["not ready: delete restricted", "delete_restricted", rowFor("saved"), { draftsReady: false, restricted: true }, "drafts_unavailable"],
    // drafts off
    ["drafts off: edit", "edit", rowFor("draft"), { draftsOn: false }, "drafts_off"],
    ["drafts off: regenerate", "regenerate", rowFor("draft"), { draftsOn: false }, "drafts_off"],
    ["drafts off: save", "save", rowFor("draft"), { draftsOn: false }, "drafts_off"],
    ["drafts off: review", "review", rowFor("saved"), { draftsOn: false }, "drafts_off"],
    ["drafts off: send", "send", rowFor("saved"), { draftsOn: false }, "drafts_off"],
    ["drafts off: check", "resolve:check", rowFor("saved"), { draftsOn: false }, "drafts_off"],
    ["drafts off: stop", "resolve:stop_generation", rowFor("generating"), { draftsOn: false }, "drafts_off"],
    ["drafts off: mark_sent", "resolve:mark_sent", rowFor("unknown"), { draftsOn: false }, "drafts_off"],
    ["drafts off: discard", "discard", rowFor("draft"), { draftsOn: false }, "ok"],
    ["drafts off: open", "outlook_opened", rowFor("saved"), { draftsOn: false }, "ok"],
    ["drafts off: delete restricted", "delete_restricted", rowFor("saved"), { draftsOn: false, restricted: true }, "ok"],
    // sent copy found (T44)
    ["found: mark_sent", "resolve:mark_sent", rowFor("unknown"), { sentCopy: "found" }, "sent_copy_found"],
    ["found: not_sent", "resolve:not_sent_new_draft", rowFor("unknown"), { sentCopy: "found" }, "sent_copy_found"],
    ["found: copy", "resolve:copy_to_new_draft", confirmed, { sentCopy: "found" }, "sent_copy_found"],
    // the send's review checks
    ["send: no review", "send", rowFor("saved", { reviewHash: null, reviewAt: null }), {}, "review_required"],
    ["send: review at exactly 10 min", "send", rowFor("saved", { reviewAt: at(-DRAFT_LIMITS.reviewTtlMs) }), {}, "ok"],
    ["send: review 10 min + 1 ms", "send", rowFor("saved", { reviewAt: at(-DRAFT_LIMITS.reviewTtlMs - 1) }), {}, "review_expired"],
    ["send: opened after the review", "send", rowFor("saved", { reviewAt: at(-2 * MIN), openedInOutlookAt: at(-MIN) }), {}, "review_required"],
    ["send: opened before the review", "send", rowFor("saved", { reviewAt: at(-MIN), openedInOutlookAt: at(-2 * MIN) }), {}, "ok"],
    ["review: saved_version behind", "review", rowFor("saved", { savedVersion: 1 }), {}, "state_conflict"],
    ["send: saved_version behind", "send", rowFor("saved", { savedVersion: 1 }), {}, "state_conflict"],
    ["check: DD-only draft", "resolve:check", rowFor("draft"), {}, "state_conflict"],
    ["not_sent: gone", "resolve:not_sent_new_draft", held, {}, "state_conflict"],
    ["open: DD-only draft", "outlook_opened", rowFor("draft"), {}, "state_conflict"]
  ];
  const all = [...rows, ...variants];
  it(`covers at least 180 rows (${all.length})`, () => {
    expect(all.length).toBeGreaterThanOrEqual(180);
  });
  it.each(all)("%s", (_label, action, row, ctx, expected) => {
    expect(verdict(guard(action, row, { ...CTX, ...ctx }))).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// ST05 capabilities
// ---------------------------------------------------------------------------

describe("ST05 capabilitiesFor", () => {
  const caps = (row: ExecDraftRow, ctx: Partial<GuardContext> & { draftsUnavailable?: "token_missing" | "drafts_off" | null; sendUnavailable?: "send_token" | null } = {}) =>
    capabilitiesFor(row, { ...CTX, checkedOutlook: undefined, sentCopy: undefined, draftsUnavailable: null, sendUnavailable: null, ...ctx });
  const buttons = (row: ExecDraftRow, ctx: Parameters<typeof caps>[1] = {}) => {
    const c = caps(row, ctx);
    const on = (["canEdit", "canRegenerate", "canSave", "canReview", "canDiscard", "canDeleteRestricted", "canOpenInOutlook"] as const).filter((k) => c[k]);
    return [...on, ...c.resolve.map((r) => `resolve:${r}`)].sort();
  };
  const sorted = (xs: string[]) => [...xs].sort();
  const stale = rowFor("draft", { ...LINK, savedVersion: 1 });
  const cases: [string, ExecDraftRow, Parameters<typeof caps>[1], string[]][] = [
    ["generating: Stop", rowFor("generating"), {}, ["resolve:stop_generation"]],
    ["generation_failed: Try again, Write it myself, Discard", rowFor("generation_failed"), {}, ["canEdit", "canRegenerate", "canDiscard"]],
    ["draft, no link: Regenerate, Save, Discard (editable)", rowFor("draft"), {}, ["canEdit", "canRegenerate", "canSave", "canDiscard"]],
    ["draft, stale link: Save again, Regenerate, Check again, Discard (+ Open per T41)", stale, {}, ["canEdit", "canRegenerate", "canSave", "canDiscard", "canOpenInOutlook", "resolve:check"]],
    ["draft, changed in Outlook: the four actions (check, save with the hash, keep, discard)", rowFor("draft", { ...LINK, savedVersion: 1, lastErrorCode: "outlook_changed" }), {},
      ["canEdit", "canRegenerate", "canSave", "canDiscard", "canOpenInOutlook", "resolve:check", "resolve:keep_outlook_version"]],
    ["saving: nothing", rowFor("saving"), {}, []],
    ["saved: Review & send, Open in Outlook, Check again, Regenerate, Discard (editable)", rowFor("saved"), {},
      ["canEdit", "canRegenerate", "canReview", "canDiscard", "canOpenInOutlook", "resolve:check"]],
    ["saved with sendUnavailable: no Review & send", rowFor("saved"), { sendReady: false, sendUnavailable: "send_token" },
      ["canEdit", "canRegenerate", "canDiscard", "canOpenInOutlook", "resolve:check"]],
    ["saved, changed in Outlook: as saved plus keep", rowFor("saved", { observedContentHash: HEX("e") }), {},
      ["canEdit", "canRegenerate", "canReview", "canDiscard", "canOpenInOutlook", "resolve:check", "resolve:keep_outlook_version"]],
    ["saved + outlook_edited: as saved", rowFor("saved", { outlookEdited: true }), {}, ["canEdit", "canRegenerate", "canReview", "canDiscard", "canOpenInOutlook", "resolve:check"]],
    ["sending: nothing", rowFor("sending"), {}, []],
    ["sent_pending: Open sent copy, Check again", rowFor("sent_pending"), {}, ["canOpenInOutlook", "resolve:check"]],
    ["sent: nothing (links only)", rowFor("sent"), {}, []],
    ["sent_external: nothing", rowFor("sent_external"), {}, []],
    ["unknown < 30 min: Check again, Open in Outlook", rowFor("unknown", { sendStartedAt: at(-10 * MIN) }), {}, ["canOpenInOutlook", "resolve:check"]],
    ["unknown >= 30 min: Check again, It was sent, It wasn't sent", rowFor("unknown"), {}, ["canOpenInOutlook", "resolve:check", "resolve:mark_sent", "resolve:not_sent_new_draft"]],
    ["unknown >= 30 min with the flag: the same", rowFor("unknown", { cloneFlags: ["send_status_unknown"] }), {}, ["canOpenInOutlook", "resolve:check", "resolve:mark_sent", "resolve:not_sent_new_draft"]],
    ["gone unconfirmed: Check again, Make a new draft, It was sent", rowFor("gone"), {}, ["resolve:check", "resolve:copy_to_new_draft", "resolve:mark_sent"]],
    ["gone confirmed: Make a new draft, It was sent", rowFor("gone", { goneUnconfirmed: false, nextCheckAt: null }), {}, ["resolve:copy_to_new_draft", "resolve:mark_sent"]],
    ["gone reappeared: nothing", rowFor("gone", { goneUnconfirmed: false, nextCheckAt: null, lastErrorCode: "outlook_reappeared" }), {}, []],
    ["discarding: nothing", rowFor("discarding"), {}, []],
    ["discarded: nothing", rowFor("discarded"), {}, []],
    ["restricted saved: Delete only", rowFor("saved"), { restricted: true }, ["canDeleteRestricted"]],
    ["restricted linked draft: Delete only", stale, { restricted: true }, ["canDeleteRestricted"]],
    ["restricted unknown: Check again, It was sent, It wasn't sent (delete)", rowFor("unknown"), { restricted: true }, ["resolve:check", "resolve:mark_sent", "resolve:not_sent_new_draft"]],
    ["restricted sending: nothing", rowFor("sending"), { restricted: true }, []],
    ["restricted sent: nothing", rowFor("sent"), { restricted: true }, []],
    ["restricted gone: nothing", rowFor("gone"), { restricted: true }, []],
    ["restricted DD-only draft: nothing", rowFor("draft"), { restricted: true }, []],
    ["restricted discarded: nothing", rowFor("discarded"), { restricted: true }, []],
    ["drafts unavailable, DD-only draft: Discard only", rowFor("draft"), { draftsReady: false, draftsUnavailable: "token_missing" }, ["canDiscard"]],
    ["drafts unavailable, saved: nothing", rowFor("saved"), { draftsReady: false, draftsUnavailable: "token_missing" }, []],
    ["drafts unavailable, unknown: nothing", rowFor("unknown"), { draftsReady: false, draftsUnavailable: "token_missing" }, []],
    ["drafts off, DD-only draft: Discard only", rowFor("draft"), { draftsOn: false, draftsUnavailable: "drafts_off" }, ["canDiscard"]]
  ];
  it.each(cases)("%s", (_label, row, ctx, expected) => {
    expect(buttons(row, ctx)).toEqual(sorted(expected));
  });
  it("passes draftsUnavailable / sendUnavailable through, and a sent copy found hides the owner choices", () => {
    const c = caps(rowFor("saved"), { draftsReady: false, draftsUnavailable: "token_missing", sendUnavailable: "send_token" });
    expect(c.draftsUnavailable).toBe("token_missing");
    expect(c.sendUnavailable).toBe("send_token");
    expect(caps(rowFor("unknown"), { sentCopy: "found" }).resolve).toEqual(["check"]);
    expect(caps(rowFor("saved", { webLink: null })).canOpenInOutlook).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ST06 mirrorRegistry
// ---------------------------------------------------------------------------

describe("ST06 mirrorRegistry", () => {
  const mirror = (row: ExecDraftRow, status: CloneDraftStatus, read: CloneDraftRead | null = null, flags: string[] = read?.flags ?? [], replacedBy?: string | null) =>
    tx(`${row.status} + ${status}`, row, mirrorRegistry(row, { status, flags, read, replacedBy }, NOW));
  const CLEARED = { review_hash: null, review_at: null, review_blockers: [], review_recipients: null };

  it("saved without the flag: C15 from sending / unknown, unchanged from saved and a linked draft, prior from discarding", () => {
    for (const src of ["sending", "unknown"] as const) {
      const t = mirror(rowFor(src), "saved", readBack());
      expect(t.to).toBe("saved");
      expect(t.reviewCleared).toBe(true);
      expect(t.patch).toMatchObject({ status: "saved", ...CLEARED, observed_content_hash: HEX("d"), last_error_code: null, next_check_at: null });
      expect(t.patch).not.toHaveProperty("content_hash");
    }
    const same = mirror(rowFor("saved"), "saved", readBack({ contentHash: HEX("e"), flags: ["signature_skipped"] }));
    expect(same.to).toBe("saved");
    expect(same.reviewCleared).toBe(false);
    expect(same.patch).toMatchObject({ observed_content_hash: HEX("e"), clone_flags: ["signature_skipped"], internet_message_id: "<new@x>", web_link: "https://outlook.office.com/y" });
    expect(same.patch).not.toHaveProperty("status");
    expect(same.patch).not.toHaveProperty("content_hash");
    expect(same.patch).not.toHaveProperty("review_hash");
    const stale = mirror(rowFor("draft", { ...LINK, savedVersion: 1 }), "saved", readBack());
    expect(stale.to).toBe("draft");
    expect(stale.patch).not.toHaveProperty("status");
    const fromDiscarding = mirror(rowFor("discarding"), "saved", readBack());
    expect(fromDiscarding.to).toBe("saved");
    expect(fromDiscarding.patch).toMatchObject({ status: "saved", prior_status: null });
    const draftPrior = mirror(rowFor("discarding", { priorStatus: "saved", savedVersion: 1 }), "saved", readBack());
    expect(draftPrior.to).toBe("draft");
    const unknownPrior = mirror(rowFor("discarding", { priorStatus: "unknown" }), "saved", readBack());
    expect(unknownPrior.to).toBe("unknown");
  });

  it("gone -> saved on a live draft (v2): terminal_at / expires_at / gone_at cleared, link kept, review cleared; a registry view changes nothing", () => {
    for (const row of [rowFor("gone"), rowFor("gone", { goneUnconfirmed: false, nextCheckAt: null })]) {
      const t = mirror(row, "saved", readBack());
      expect(t.to).toBe("saved");
      expect(t.patch).toMatchObject({ status: "saved", gone_unconfirmed: false, gone_at: null, terminal_at: null, expires_at: null, ...CLEARED });
      expect(t.patch).not.toHaveProperty("outlook_graph_id");
      expect(t.reviewCleared).toBe(true);
    }
    expect(mirror(rowFor("gone"), "saved", registryView("saved")).to).toBe("gone");
    expect(mirror(rowFor("gone"), "saved", readBack({ isDraft: false })).to).toBe("gone");
  });

  it("gone -> draft when the reappeared Outlook draft holds an older version (data-2): a stale link stays a draft", () => {
    // A linked draft at version 3 whose Outlook copy holds version 2 goes gone, then reappears.
    const staleDraft = rowFor("draft", { ...LINK, version: 3, savedVersion: 2 });
    const wentGone = mirror(staleDraft, "deleted", null);
    expect(wentGone.to).toBe("gone");
    const goneRow = applyDraftPatch(staleDraft, wentGone.patch);
    const back = mirror(goneRow, "saved", readBack());
    expect(back.to).toBe("draft");
    expect(back.patch).toMatchObject({ status: "draft", gone_unconfirmed: false, gone_at: null, terminal_at: null, expires_at: null, ...CLEARED });
    expect(isStaleLink(applyDraftPatch(goneRow, back.patch))).toBe(true);
    // A purged row reappearing is never "saved" either.
    expect(mirrorRegistry(rowFor("gone", { restrictedPurged: true }), { status: "saved", flags: [], read: readBack() }, NOW).to).toBe("draft");
  });

  it("saving -> a linked target writes the link, saved_version and the content hash in the same CAS (the replay's T18/T19)", () => {
    const t = mirror(rowFor("saving"), "saved", readBack({ flags: ["signature_skipped"] }));
    expect(t.to).toBe("saved");
    expect(t.patch).toMatchObject({ status: "saved", outlook_graph_id: GRAPH, saved_version: 2, content_hash: HEX("d"), observed_content_hash: HEX("d"),
      signature_skipped: true, outlook_edited: false, last_error_code: null, next_check_at: null, internet_message_id: "<new@x>" });
    const pending = mirror(rowFor("saving"), "sent_pending_verification", readBack({ status: "sent_pending_verification" }));
    expect(pending.to).toBe("sent_pending");
    expect(pending.patch).toMatchObject({ outlook_graph_id: GRAPH, send_accepted_at: NOW.toISOString() });
    // Nowhere to link: a saving create answered by a bodiless draftStatus stays saving as an anomaly.
    const noLink = mirror(rowFor("saving"), "sending", null);
    expect(noLink.to).toBe("saving");
    expect(noLink.code).toBe("clone_anomaly");
    expect(noLink.alert).toBe("clone-anomaly");
  });

  it("saved + send_status_unknown -> unknown from every source, flag kept", () => {
    for (const src of ["saved", "sending", "sent_pending", "discarding", "gone"] as const) {
      const row = rowFor(src);
      const t = mirror(row, "saved", readBack({ flags: ["send_status_unknown"] }));
      expect(t.to, src).toBe("unknown");
      expect(t.patch).toMatchObject({ status: "unknown", clone_flags: ["send_status_unknown"], gone_unconfirmed: false, ...CLEARED });
      expect(t.patch).not.toHaveProperty("send_started_at");
    }
    const already = mirror(rowFor("unknown", { cloneFlags: ["send_status_unknown"] }), "saved", readBack({ flags: ["send_status_unknown"] }));
    expect(already.to).toBe("unknown");
    expect(already.patch).not.toHaveProperty("status");
    // A linked draft is kept (stale link) rather than moved: the flag arrives through a read of the Outlook draft it points to.
  });

  it("sending / unknown -> unknown with the flags mirrored; from gone unchanged", () => {
    const t = mirror(rowFor("sending"), "sending", registryView("sending", { flags: ["create_unconfirmed"] }));
    expect(t.to).toBe("unknown");
    expect(t.patch).toMatchObject({ status: "unknown", clone_flags: ["create_unconfirmed"], ...CLEARED });
    expect(mirror(rowFor("saved"), "unknown", registryView("unknown")).to).toBe("unknown");
    expect(mirror(rowFor("discarding"), "unknown", registryView("unknown")).to).toBe("unknown");
    expect(mirror(rowFor("gone"), "unknown", registryView("unknown")).to).toBe("gone");
    expect(mirror(rowFor("unknown"), "unknown", registryView("unknown")).patch).not.toHaveProperty("status");
  });

  it("sent_pending_verification -> sent_pending; sent / sent_mismatch -> sent with sent_at and the alert; sent_external", () => {
    const p = mirror(rowFor("sending"), "sent_pending_verification", readBack({ status: "sent_pending_verification" }));
    expect(p.to).toBe("sent_pending");
    expect(p.patch).toMatchObject({ status: "sent_pending", internet_message_id: "<new@x>" });
    const s = mirror(rowFor("sent_pending"), "sent", registryView("sent", { flags: ["unverified"], webLink: "https://outlook.office.com/sent" }));
    expect(s.to).toBe("sent");
    expect(s.patch).toMatchObject({ status: "sent", unverified: true, sent_mismatch: false, sent_at: rowFor("sent_pending").sendAcceptedAt, web_link: "https://outlook.office.com/sent", terminal_at: NOW.toISOString(), next_check_at: null });
    expect(s.alert).toBeNull();
    const m = mirror(rowFor("sent_pending"), "sent_mismatch", registryView("sent_mismatch"));
    expect(m.to).toBe("sent");
    expect(m.patch).toMatchObject({ sent_mismatch: true });
    expect(m.alert).toBe("draft-sent-mismatch");
    const live = mirror(rowFor("unknown"), "sent", readBack({ status: "sent", isDraft: false, sentAt: at(-3 * MIN) }));
    expect(live.patch).toMatchObject({ sent_at: at(-3 * MIN) });
    for (const src of ["saved", "sending", "unknown", "gone", "discarding", "sent_pending"] as const) {
      expect(mirror(rowFor(src), "sent_external", registryView("sent_external")).to, src).toBe("sent_external");
      expect(mirror(rowFor(src), "sent", registryView("sent")).to, src).toBe("sent");
    }
    const sentRow = mirror(rowFor("sent"), "sent_mismatch", registryView("sent_mismatch"));
    expect(sentRow.to).toBe("sent");
    expect(sentRow.patch).toMatchObject({ sent_mismatch: true });
    expect(sentRow.alert).toBe("draft-sent-mismatch");
  });

  it("deleted: discarding -> discarded (T43's prior unknown records not_sent); saving -> draft + recreate_failed or follow the replacement; else gone unconfirmed", () => {
    const d = mirror(rowFor("discarding"), "deleted", null);
    expect(d.to).toBe("discarded");
    expect(d.patch).toMatchObject({ status: "discarded", prior_status: null, terminal_at: NOW.toISOString(), next_check_at: null });
    expect(d.patch).not.toHaveProperty("owner_resolution");
    const t43 = mirror(rowFor("discarding", { priorStatus: "unknown" }), "deleted", null);
    expect(t43.patch).toMatchObject({ status: "discarded", owner_resolution: "not_sent" });
    const re = mirror(rowFor("saving", { ...LINK, savedVersion: 1 }), "deleted", null);
    expect(re.to).toBe("draft");
    expect(re.code).toBe("recreate_failed");
    expect(re.patch).toMatchObject({ status: "draft", outlook_graph_id: null, web_link: null, last_error_code: "recreate_failed" });
    const follow = mirror(rowFor("saving", { ...LINK, savedVersion: 1 }), "deleted", null, [], "NEWID");
    expect(follow.to).toBe("saving");
    expect(follow.code).toBe("follow_replacement");
    for (const src of ["saved", "sending", "sent_pending", "unknown"] as const) {
      const g = mirror(rowFor(src), "deleted", null);
      expect(g.to, src).toBe("gone");
      expect(g.patch).toMatchObject({ status: "gone", gone_unconfirmed: true, gone_at: NOW.toISOString(), terminal_at: NOW.toISOString(), next_check_at: at(2 * MIN) });
    }
    expect(mirror(rowFor("draft", { ...LINK, savedVersion: 1 }), "deleted", null).to).toBe("gone");
  });

  it("gone -> gone unconfirmed from every live source, discarding included (T40); from a gone source nothing changes", () => {
    for (const src of ["saved", "sending", "sent_pending", "unknown", "discarding"] as const) {
      const g = mirror(rowFor(src), "gone", null);
      expect(g.to, src).toBe("gone");
      expect(g.patch).toMatchObject({ gone_unconfirmed: true, prior_status: null });
    }
    const confirmed = rowFor("gone", { goneUnconfirmed: false, nextCheckAt: null });
    for (const s of ["gone", "deleted"] as const) {
      const t = mirror(confirmed, s, null);
      expect(t.to).toBe("gone");
      expect(t.patch).not.toHaveProperty("gone_unconfirmed");
      expect(t.patch).not.toHaveProperty("gone_at");
    }
    const unconfirmed = mirror(rowFor("gone"), "gone", null);
    expect(unconfirmed.patch).not.toHaveProperty("gone_unconfirmed");
  });

  it("every mirror whose target isn't gone writes gone_unconfirmed = false; nothing leaves sent, sent_external or discarded", () => {
    for (const src of ["sending", "unknown", "gone", "discarding"] as const) {
      for (const s of ["saved", "sent", "sent_external", "unknown", "sent_pending_verification"] as const) {
        const t = mirrorRegistry(rowFor(src), { status: s, flags: [], read: s === "saved" ? readBack() : registryView(s) }, NOW);
        if (t.to !== "gone" && t.to !== src) expect(t.patch.gone_unconfirmed, `${src} + ${s}`).toBe(false);
      }
    }
    for (const src of ["sent", "sent_external", "discarded"] as const) {
      for (const s of ["saved", "deleted", "gone", "unknown", "sent_external"] as const) {
        const t = mirror(rowFor(src), s, s === "saved" ? readBack() : null);
        expect(t.to, `${src} + ${s}`).toBe(src);
        expect(t.patch).not.toHaveProperty("status");
      }
    }
  });

  it("creating is never a valid answer: unchanged, clone_anomaly", () => {
    const t = mirror(rowFor("saved"), "creating", null);
    expect(t.to).toBe("saved");
    expect(t.code).toBe("clone_anomaly");
    expect(t.alert).toBe("clone-anomaly");
  });
});

// ---------------------------------------------------------------------------
// ST07-ST11 the per-route maps
// ---------------------------------------------------------------------------

const SAVING = () => rowFor("saving");
const RECREATING = () => rowFor("saving", { ...LINK, savedVersion: 1, saveIfContentHash: HEX("c") });

describe("ST07 mapCreateResult", () => {
  const create = (row: ExecDraftRow, r: CloneAnswer<CloneReadBack>) => tx("create", row, mapCreateResult(row, r, NOW));
  it("201 -> saved (T18) with the link, saved_version, both hashes and the flags; a replayed 201 the same", () => {
    for (const replay of [false, true]) {
      const t = create(SAVING(), ok(readBack({ flags: ["signature_skipped"] }), replay));
      expect(t.to).toBe("saved");
      expect(t.patch).toMatchObject({ status: "saved", outlook_graph_id: GRAPH, saved_version: 2, content_hash: HEX("d"), observed_content_hash: HEX("d"),
        signature_skipped: true, clone_flags: ["signature_skipped"], outlook_edited: false, last_error_code: null, next_check_at: null });
      expect(t.code).toBeNull();
    }
  });
  it("a save result keeps opened_in_outlook_at (data-4, L13): the next review still raises opened_in_outlook", () => {
    const opened = at(-3 * MIN);
    for (const row of [SAVING(), RECREATING()]) {
      const t = create({ ...row, openedInOutlookAt: opened }, ok(readBack()));
      expect(t.to).toBe("saved");
      expect(t.patch).not.toHaveProperty("opened_in_outlook_at");
      expect(t.patch).toMatchObject({ next_check_at: null });
      expect(applyDraftPatch({ ...row, openedInOutlookAt: opened }, t.patch).openedInOutlookAt).toBe(opened);
    }
    const saving = { ...RECREATING(), openedInOutlookAt: opened };
    const viaGet = resolveRecreateByGet(saving, fail(cloneErr("get_draft", 404, "gone", { draftStatus: "deleted", replacedBy: "NEWID" })),
      ok<CloneDraftRead>(readBack({ graphId: "NEWID" })), "gone", NOW);
    expect(isTransition(viaGet) && viaGet.to).toBe("draft");
    if (isTransition(viaGet)) expect(viaGet.patch).not.toHaveProperty("opened_in_outlook_at");
    const mirrored = mirrorRegistry(saving, { status: "saved", flags: [], read: readBack() }, NOW);
    expect(mirrored.to).toBe("saved");
    expect(mirrored.patch).not.toHaveProperty("opened_in_outlook_at");
  });
  const rows: [string, CloneAnswer<CloneReadBack>, ExecDraftStatus, string, string | null][] = [
    ["400 mailbox_not_connected (exact detail)", fail(cloneErr("create_reply", 400, "bad_request", { detail: "not_microsoft" })), "draft", "mailbox_not_connected", null],
    ["400 other", fail(cloneErr("create_reply", 400, "bad_request", { detail: "bcc not allowed" })), "draft", "bad_request", "clone-ea-bug"],
    ["401 invalid_token", fail(cloneErr("create_reply", 401, "invalid_token")), "draft", "ea_auth", "clone-ea-auth"],
    ["403 forbidden_scope", fail(cloneErr("create_reply", 403, "forbidden_scope")), "draft", "ea_auth", "clone-ea-auth"],
    ["404 not_found (reply)", fail(cloneErr("create_reply", 404, "not_found")), "draft", "thread_not_found", null],
    ["409 parent_missing", fail(cloneErr("create_reply", 409, "parent_missing")), "draft", "parent_missing", null],
    ["422 idempotency_mismatch", fail(cloneErr("create_reply", 422, "idempotency_mismatch")), "draft", "idempotency_mismatch", "clone-ea-bug"],
    ["429 throttled", fail(cloneErr("create_reply", 429, "throttled")), "draft", "throttled", null],
    ["502 invalid_grant", fail(cloneErr("create_reply", 502, "graph_error", { graphCode: "token_refresh_failed:invalid_grant" })), "draft", "mailbox_reconnect", "clone-ea-auth"],
    ["502 other", fail(cloneErr("create_reply", 502, "graph_error", { graphCode: "ErrorItemNotFound" })), "draft", "graph_error", "clone-anomaly"],
    ["503 not_ready", fail(cloneErr("create_reply", 503, "not_ready")), "draft", "clone_not_ready", null],
    ["504 graph_timeout", fail(cloneErr("create_reply", 504, "graph_timeout")), "draft", "timeout", null],
    ["500 server_error", fail(cloneErr("create_reply", 500, "server_error")), "draft", "clone_error", null],
    ["transport", fail(cloneErr("create_reply", null, null)), "saving", "outcome_unknown", null],
    ["DD timeout", fail(cloneErr("create_reply", null, null, {}, { code: "timeout" })), "saving", "outcome_unknown", null],
    ["edge page", fail(cloneErr("create_reply", 502, null)), "saving", "outcome_unknown", null],
    ["unparseable 2xx", fail(cloneErr("create_reply", 201, null)), "saving", "outcome_unknown", null],
    ["unknown code", fail(cloneErr("create_reply", 418, "teapot")), "saving", "outcome_unknown", null],
    ["no answer", NO_ANSWER, "saving", "outcome_unknown", null]
  ];
  it.each(rows)("%s", (_label, r, to, code, alert) => {
    const t = create(SAVING(), r);
    expect(t.to).toBe(to);
    expect(t.code).toBe(code);
    expect(t.alert).toBe(alert);
    if (to === "draft") expect(t.patch).toMatchObject({ status: "draft", last_error_code: code, next_check_at: null });
    else expect(t.patch).toMatchObject({ last_error_code: "outcome_unknown", next_check_at: at(5 * MIN) });
  });
  it("404 on a new draft reads account_not_found; a 409 already_* with a draftStatus is mirrored and alerted", () => {
    const newRow = rowFor("saving", { kind: "new", threadId: null, parentMessageId: null, replyMode: null, threadSubject: null, threadAddresses: [], subject: "Hello" });
    expect(create(newRow, fail(cloneErr("create_new", 404, "not_found"))).code).toBe("account_not_found");
    const t = create(RECREATING(), fail(cloneErr("create_reply", 409, "already_sent", { draftStatus: "sent" })));
    expect(t.to).toBe("sent");
    expect(t.alert).toBe("clone-anomaly");
  });
  it("T25 keeps the save attempt and schedules the stale sweep", () => {
    const t = saveOutcomeUnknown(SAVING(), NOW);
    expect(t.to).toBe("saving");
    expect(t.patch).toMatchObject({ last_error_code: "outcome_unknown", last_error_at: NOW.toISOString(), next_check_at: at(5 * MIN) });
    expect(t.patch).not.toHaveProperty("status");
  });
});

describe("ST07/ST08 mapReplayResult", () => {
  const replay = (row: ExecDraftRow, kind: "create" | "recreate", r: CloneAnswer<CloneReadBack>) => mapReplayResult(row, kind, r, NOW);
  const leaves: [string, CloneAnswer<CloneReadBack>, string][] = [
    ["401", fail(cloneErr("create_reply", 401, "invalid_token")), "ea_auth"],
    ["403", fail(cloneErr("create_reply", 403, "forbidden_scope")), "ea_auth"],
    ["429 in progress", fail(cloneErr("create_reply", 429, "throttled")), "throttled"],
    ["502", fail(cloneErr("create_reply", 502, "graph_error")), "graph_error"],
    ["503", fail(cloneErr("create_reply", 503, "not_ready")), "clone_not_ready"],
    ["504", fail(cloneErr("create_reply", 504, "graph_timeout")), "timeout"],
    ["500", fail(cloneErr("create_reply", 500, "server_error")), "clone_error"],
    ["edge", fail(cloneErr("create_reply", 502, null)), "outcome_unknown"],
    ["transport", fail(cloneErr("create_reply", null, null)), "outcome_unknown"],
    ["no answer", NO_ANSWER, "outcome_unknown"]
  ];
  it.each(leaves)("create replay %s -> leaveSaving (never draft)", (_label, r, code) => {
    for (const kind of ["create", "recreate"] as const) {
      const out = replay(kind === "create" ? SAVING() : RECREATING(), kind, r);
      expect(out).toEqual({ leaveSaving: true, code });
    }
  });
  it("definitive answers map to their §2.6.1 rows; a stored 201 needs a GET; a fresh 2xx is T18", () => {
    expect(replay(SAVING(), "create", ok(readBack(), true))).toEqual({ needGet: true, graphId: GRAPH });
    const fresh = replay(SAVING(), "create", ok(readBack(), false));
    expect(isTransition(fresh) && fresh.to).toBe("saved");
    const bad = replay(SAVING(), "create", fail(cloneErr("create_reply", 400, "bad_request")));
    expect(isTransition(bad) && bad.to).toBe("draft");
    expect(isTransition(bad) && bad.code).toBe("bad_request");
    const nf = replay(SAVING(), "create", fail(cloneErr("create_reply", 404, "not_found")));
    expect(isTransition(nf) && nf.to).toBe("draft");
    const pm = replay(SAVING(), "create", fail(cloneErr("create_reply", 409, "parent_missing")));
    expect(isTransition(pm) && pm.code).toBe("parent_missing");
    const im = replay(SAVING(), "create", fail(cloneErr("create_reply", 422, "idempotency_mismatch")));
    expect(isTransition(im) && im.to).toBe("draft");
  });
  it("recreate replay: a stored 200 needs a GET; 404 gone/deleted -> draft, link NULL, recreate_failed; 404 gone/gone -> T23; 409 changed -> T21; 409 sent_externally -> T22", () => {
    expect(replay(RECREATING(), "recreate", ok(readBack({ graphId: "NEW" }), true))).toEqual({ needGet: true, graphId: "NEW" });
    const deleted = replay(RECREATING(), "recreate", fail(cloneErr("recreate", 404, "gone", { draftStatus: "deleted" })));
    expect(isTransition(deleted) && deleted.to).toBe("draft");
    expect(isTransition(deleted) && deleted.code).toBe("recreate_failed");
    expect(isTransition(deleted) && deleted.patch).toMatchObject({ outlook_graph_id: null });
    const gone = replay(RECREATING(), "recreate", fail(cloneErr("recreate", 404, "gone", { draftStatus: "gone" })));
    expect(isTransition(gone) && gone.to).toBe("gone");
    expect(isTransition(gone) && gone.patch).toMatchObject({ gone_unconfirmed: true, next_check_at: at(2 * MIN) });
    const changed = replay(RECREATING(), "recreate", fail(cloneErr("recreate", 409, "changed", { draftStatus: "saved" })));
    expect(isTransition(changed) && changed.to).toBe("draft");
    expect(isTransition(changed) && changed.code).toBe("outlook_changed");
    expect(isTransition(changed) && changed.patch).not.toHaveProperty("content_hash");
    const ext = replay(RECREATING(), "recreate", fail(cloneErr("recreate", 409, "sent_externally")));
    expect(isTransition(ext) && ext.to).toBe("sent_external");
    const replaced = replay(RECREATING(), "recreate", fail(cloneErr("recreate", 404, "gone", { draftStatus: "deleted", replacedBy: "NEW" })));
    expect(isTransition(replaced) && replaced.code).toBe("follow_replacement");
  });
  it("unresolved 24 h after save_started_at -> T52 (draft, outlook_unknown); the create's link stays NULL", () => {
    const old = rowFor("saving", { saveStartedAt: at(-DRAFT_LIMITS.replayGiveUpMs) });
    const t = replay(old, "create", fail(cloneErr("create_reply", 503, "not_ready")));
    expect(isTransition(t) && t.to).toBe("draft");
    expect(isTransition(t) && t.code).toBe("outlook_unknown");
    expect(isTransition(t) && t.patch.outlook_graph_id).toBeUndefined();
    const t52 = tx("T52", RECREATING(), giveUpSaving(RECREATING(), NOW));
    expect(t52.patch).toMatchObject({ status: "draft", last_error_code: "outlook_unknown" });
    expect(t52.patch).not.toHaveProperty("outlook_graph_id");
    const t51 = tx("T51", rowFor("saving", { restrictedPurged: true, toRecipients: [], threadSubject: null, threadAddresses: [], bodyDoc: null, bodyHtml: null, bodyText: null, instruction: null, recipientsSig: null, contentPurgedAt: at(-MIN) }), closePurgedCreate(rowFor("saving"), NOW));
    expect(t51.to).toBe("discarded");
    expect(t51.code).toBe("outlook_unknown_restricted");
  });
});

describe("ST08 mapRecreateResult + resolveRecreateByGet", () => {
  const recreate = (r: CloneAnswer<CloneReadBack>) => mapRecreateResult(RECREATING(), r, NOW);
  it("200 -> saved (T19) with the new link", () => {
    const t = recreate(ok(readBack({ graphId: "NEW", replaces: GRAPH })));
    expect(isTransition(t) && t.patch).toMatchObject({ status: "saved", outlook_graph_id: "NEW", saved_version: 2, content_hash: HEX("d") });
  });
  it("409 changed -> T21 (draft, link kept, outlook_changed, content_hash unchanged); 409 sent_externally -> T22; 404 gone by draftStatus", () => {
    const t = recreate(fail(cloneErr("recreate", 409, "changed", { draftStatus: "saved" })));
    expect(isTransition(t) && t.to).toBe("draft");
    expect(isTransition(t) && t.code).toBe("outlook_changed");
    expect(isTransition(t) && t.patch).not.toHaveProperty("content_hash");
    expect(isTransition(t) && t.patch).not.toHaveProperty("outlook_graph_id");
    const ext = recreate(fail(cloneErr("recreate", 409, "sent_externally")));
    expect(isTransition(ext) && ext.to).toBe("sent_external");
    expect(isTransition(ext) && ext.patch).toMatchObject({ terminal_at: NOW.toISOString() });
    const gone = recreate(fail(cloneErr("recreate", 404, "gone", { draftStatus: "gone" })));
    expect(isTransition(gone) && gone.to).toBe("gone");
    const deleted = recreate(fail(cloneErr("recreate", 404, "gone", { draftStatus: "deleted" })));
    expect(isTransition(deleted) && deleted.code).toBe("recreate_failed");
    expect(isTransition(deleted) && deleted.patch).toMatchObject({ outlook_graph_id: null });
    const replaced = recreate(fail(cloneErr("recreate", 404, "gone", { draftStatus: "deleted", replacedBy: "NEW" })));
    expect(isTransition(replaced) && replaced.code).toBe("follow_replacement");
    expect(recreate(fail(cloneErr("recreate", 404, "gone")))).toEqual({ needGetResolution: true, code: "gone" });
  });
  it("every other answered error needs the GET resolution; no answer and the four failures leave saving", () => {
    for (const [status, error, code] of [[400, "bad_request", "bad_request"], [404, "not_found", "not_in_registry"], [409, "parent_missing", "parent_missing"],
      [422, "idempotency_mismatch", "idempotency_mismatch"], [429, "throttled", "throttled"], [502, "graph_error", "graph_error"], [503, "not_ready", "clone_not_ready"],
      [504, "graph_timeout", "timeout"], [500, "server_error", "clone_error"], [401, "invalid_token", "ea_auth"]] as const) {
      expect(recreate(fail(cloneErr("recreate", status, error)))).toEqual({ needGetResolution: true, code });
    }
    expect(recreate(NO_ANSWER)).toEqual({ leaveSaving: true });
    expect(recreate(fail(cloneErr("recreate", null, null)))).toEqual({ leaveSaving: true });
    expect(recreate(fail(cloneErr("recreate", 502, null)))).toEqual({ leaveSaving: true });
    expect(recreate(fail(cloneErr("recreate", 418, "teapot")))).toEqual({ leaveSaving: true });
  });
  it("resolveRecreateByGet: old still saved -> draft with the original code (link kept); deleted + replacement -> a stale link to it (data-3, observed only); deleted alone -> draft, link NULL; anything else leaves saving", () => {
    const row = RECREATING();
    const still = resolveRecreateByGet(row, ok(readBack({ contentHash: HEX("f") })), null, "graph_error", NOW);
    expect(isTransition(still) && still.to).toBe("draft");
    expect(isTransition(still) && still.code).toBe("graph_error");
    expect(isTransition(still) && still.patch).toMatchObject({ observed_content_hash: HEX("f") });
    expect(isTransition(still) && still.patch).not.toHaveProperty("content_hash");
    expect(isTransition(still) && still.patch).not.toHaveProperty("outlook_graph_id");
    if (isTransition(still)) tx("resolve still", row, still);
    const gone = fail<CloneDraftRead>(cloneErr("get_draft", 404, "gone", { draftStatus: "deleted", replacedBy: "NEW" }));
    const replaced = resolveRecreateByGet(row, gone, ok<CloneDraftRead>(readBack({ graphId: "NEW", contentHash: HEX("9") })), "graph_error", NOW);
    // The replacement is an earlier attempt's (never this key's own 200): linked, but as a stale link, so the next
    // Save shows him that version (409 changed) and recreates it with the current text.
    expect(isTransition(replaced) && replaced.to).toBe("draft");
    expect(isTransition(replaced) && replaced.patch).toMatchObject({ status: "draft", outlook_graph_id: "NEW", observed_content_hash: HEX("9"), last_error_code: null, review_hash: null });
    expect(isTransition(replaced) && replaced.patch).not.toHaveProperty("content_hash");
    expect(isTransition(replaced) && replaced.patch).not.toHaveProperty("saved_version");
    if (isTransition(replaced)) {
      tx("resolve replaced", row, replaced);
      const after = applyDraftPatch(row, replaced.patch);
      expect(isStaleLink(after)).toBe(true);
      expect(after.savedVersion).toBe(1);
      expect(changedSinceSaved(after)).toBe(true);
    }
    // A replacement that was sent meanwhile is mirrored, not linked stale.
    const sentRepl = linkReplacement(row, registryView("sent", { graphId: "NEW" }), NOW);
    expect(sentRepl.to).toBe("sent");
    expect(resolveRecreateByGet(row, gone, null, "graph_error", NOW)).toEqual({ leaveSaving: true });
    expect(resolveRecreateByGet(row, gone, fail(cloneErr("get_draft", 503, "not_ready")), "graph_error", NOW)).toEqual({ leaveSaving: true });
    const alone = resolveRecreateByGet(row, fail(cloneErr("get_draft", 404, "gone", { draftStatus: "deleted" })), null, "graph_error", NOW);
    expect(isTransition(alone) && alone.to).toBe("draft");
    expect(isTransition(alone) && alone.code).toBe("recreate_failed");
    expect(isTransition(alone) && alone.patch).toMatchObject({ outlook_graph_id: null });
    if (isTransition(alone)) tx("resolve alone", row, alone);
    expect(resolveRecreateByGet(row, fail(cloneErr("get_draft", 404, "gone", { draftStatus: "gone" })), null, "graph_error", NOW)).toEqual({ leaveSaving: true });
    expect(resolveRecreateByGet(row, fail(cloneErr("get_draft", 503, "not_ready")), null, "graph_error", NOW)).toEqual({ leaveSaving: true });
    expect(resolveRecreateByGet(row, NO_ANSWER, null, "graph_error", NOW)).toEqual({ leaveSaving: true });
    expect(resolveRecreateByGet(row, ok(registryView("sent_external")), null, "graph_error", NOW)).toEqual({ leaveSaving: true });
  });
});

describe("ST09 mapDeleteResult", () => {
  const del = (row: ExecDraftRow, r: CloneAnswer<{ graphId: string; status: "deleted" }>) => mapDeleteResult(row, r, NOW);
  const priors: [string, ExecDraftRow, ExecDraftStatus][] = [
    ["prior draft", rowFor("discarding", { priorStatus: "draft", savedVersion: 1 }), "draft"],
    ["prior saved", rowFor("discarding", { priorStatus: "saved" }), "saved"],
    ["prior saved, version moved on", rowFor("discarding", { priorStatus: "saved", savedVersion: 1 }), "draft"],
    ["prior unknown (T43)", rowFor("discarding", { priorStatus: "unknown", ...SEND }), "unknown"]
  ];
  it.each(priors)("%s: every failure returns to it, never to an inferred saved; 200 -> discarded", (_label, row, prior) => {
    for (const [status, error, code] of [[400, "bad_request", "bad_request"], [401, "invalid_token", "ea_auth"], [403, "forbidden_scope", "ea_auth"],
      [422, "idempotency_mismatch", "idempotency_mismatch"], [429, "throttled", "throttled"], [502, "graph_error", "graph_error"],
      [503, "not_ready", "clone_not_ready"], [504, "graph_timeout", "timeout"], [500, "server_error", "clone_error"]] as const) {
      const t = del(row, fail(cloneErr("delete", status, error)));
      expect(isTransition(t) && t.to, `${status} ${error}`).toBe(prior);
      expect(isTransition(t) && t.code).toBe(code);
      expect(isTransition(t) && t.patch).toMatchObject({ status: prior, prior_status: null });
      if (isTransition(t)) tx(`delete ${error}`, row, t);
    }
    const changed = del(row, fail(cloneErr("delete", 409, "changed", { draftStatus: "saved" })));
    expect(isTransition(changed) && changed.to).toBe(prior);
    expect(isTransition(changed) && changed.code).toBe("outlook_changed");
    expect(isTransition(changed) && changed.patch).not.toHaveProperty("content_hash");
    if (isTransition(changed)) tx("delete changed", row, changed);
    const done = del(row, ok({ graphId: GRAPH, status: "deleted" }));
    expect(isTransition(done) && done.to).toBe("discarded");
    expect(isTransition(done) && done.patch).toMatchObject({ status: "discarded", terminal_at: NOW.toISOString(), prior_status: null });
    if (prior === "unknown") expect(isTransition(done) && done.patch).toMatchObject({ owner_resolution: "not_sent" });
    else expect(isTransition(done) && done.patch).not.toHaveProperty("owner_resolution");
    if (isTransition(done)) tx("delete ok", row, done);
  });
  it("404 gone/gone -> gone unconfirmed; 404 gone/deleted -> discarded; 404 not_found -> discarded + not_in_registry; 409 sent_externally; 409 already_* by draftStatus; no answer leaves discarding", () => {
    const row = rowFor("discarding");
    const g = del(row, fail(cloneErr("delete", 404, "gone", { draftStatus: "gone" })));
    expect(isTransition(g) && g.to).toBe("gone");
    expect(isTransition(g) && g.code).toBe("gone");
    const d = del(row, fail(cloneErr("delete", 404, "gone", { draftStatus: "deleted" })));
    expect(isTransition(d) && d.to).toBe("discarded");
    const bare = del(row, fail(cloneErr("delete", 404, "gone")));
    expect(isTransition(bare) && bare.to).toBe("gone");
    const nf = del(row, fail(cloneErr("delete", 404, "not_found")));
    expect(isTransition(nf) && nf.to).toBe("discarded");
    expect(isTransition(nf) && nf.code).toBe("not_in_registry");
    expect(isTransition(nf) && nf.alert).toBe("draft-registry-missing");
    const ext = del(row, fail(cloneErr("delete", 409, "sent_externally")));
    expect(isTransition(ext) && ext.to).toBe("sent_external");
    const sending = del(row, fail(cloneErr("delete", 409, "already_sending", { draftStatus: "sending" })));
    expect(isTransition(sending) && sending.to).toBe("unknown");
    const sent = del(row, fail(cloneErr("delete", 409, "already_sent", { draftStatus: "sent" })));
    expect(isTransition(sent) && sent.to).toBe("sent");
    for (const r of [NO_ANSWER, fail(cloneErr("delete", null, null)), fail(cloneErr("delete", 502, null)), fail(cloneErr("delete", 200, null)), fail(cloneErr("delete", 418, "teapot"))]) {
      expect(del(row, r as CloneAnswer<{ graphId: string; status: "deleted" }>)).toEqual({ leaveDiscarding: true });
    }
    for (const t of [g, d, bare, nf, ext, sending, sent]) if (isTransition(t)) tx("delete misc", row, t);
  });
});

describe("ST10/ST11 mapSendResult", () => {
  const sending = () => rowFor("sending");
  const send = (outcome: Parameters<typeof mapSendResult>[1], row = sending()) => tx("send", row, mapSendResult(row, outcome, NOW));
  const e = (status: number | null, error: string | null, over: Partial<CloneErrorBody> = {}, extra: { code?: string } = {}) =>
    ({ kind: "error" as const, error: cloneErr("send", status, error, over, extra) });
  it("202 -> sent_pending with send_accepted_at, the message id, S1 and the review cleared", () => {
    const t = send({ kind: "accepted", internetMessageId: "<sent@x>", replay: false });
    expect(t.to).toBe("sent_pending");
    expect(t.code).toBe("accepted");
    expect(t.reviewCleared).toBe(true);
    expect(t.patch).toMatchObject({ status: "sent_pending", send_accepted_at: NOW.toISOString(), internet_message_id: "<sent@x>", check_count: 0, next_check_at: at(20_000), review_hash: null });
    const noId = send({ kind: "accepted", internetMessageId: null, replay: true });
    expect(noId.patch).not.toHaveProperty("internet_message_id");
  });
  const rows: [string, ReturnType<typeof e>, ExecDraftStatus, string, boolean, string | null][] = [
    ["409 changed", e(409, "changed", { draftStatus: "saved" }), "saved", "changed", false, null],
    ["409 already_sending with sending", e(409, "already_sending", { draftStatus: "sending" }), "unknown", "already_sending", false, null],
    ["409 already_sending provisional (no draftStatus)", e(409, "already_sending"), "unknown", "already_sending", false, null],
    ["409 already_sent / spv", e(409, "already_sent", { draftStatus: "sent_pending_verification" }), "sent_pending", "already_sent", false, null],
    ["409 already_sent / sent", e(409, "already_sent", { draftStatus: "sent" }), "sent", "already_sent", false, null],
    ["409 already_sent / sent_mismatch", e(409, "already_sent", { draftStatus: "sent_mismatch" }), "sent", "already_sent", false, "draft-sent-mismatch"],
    ["409 sent_externally", e(409, "sent_externally", { draftStatus: "sent_external" }), "sent_external", "sent_externally", false, null],
    ["409 parent_missing (K5 anomaly)", e(409, "parent_missing"), "saved", "clone_anomaly", true, "clone-anomaly"],
    ["403 send_disabled", e(403, "forbidden_scope", { detail: "send_disabled" }), "saved", "send_disabled", true, null],
    ["401", e(401, "invalid_token"), "saved", "ea_auth", true, "clone-ea-auth"],
    ["403 other", e(403, "forbidden_scope", { detail: "account not in token" }), "saved", "ea_auth", true, "clone-ea-auth"],
    ["400", e(400, "bad_request"), "saved", "bad_request", true, "clone-ea-bug"],
    ["404 not_found", e(404, "not_found"), "saved", "clone_anomaly", false, "draft-registry-missing"],
    ["404 gone / gone", e(404, "gone", { draftStatus: "gone" }), "gone", "gone", false, null],
    ["404 gone / deleted", e(404, "gone", { draftStatus: "deleted" }), "gone", "gone", false, null],
    ["404 gone / saved (K24 revert)", e(404, "gone", { draftStatus: "saved" }), "saved", "outlook_not_found", false, null],
    ["404 gone without draftStatus", e(404, "gone"), "unknown", "clone_anomaly", false, "draft-send-unknown"],
    ["422", e(422, "idempotency_mismatch"), "unknown", "idempotency_mismatch", false, "clone-ea-bug"],
    ["429", e(429, "throttled", { draftStatus: "saved" }), "saved", "throttled", true, null],
    ["502 + saved", e(502, "graph_error", { draftStatus: "saved" }), "saved", "graph_error", true, "clone-anomaly"],
    ["502 invalid_grant + saved", e(502, "graph_error", { draftStatus: "saved", graphCode: "token_refresh_failed:invalid_grant" }), "saved", "mailbox_reconnect", true, "clone-ea-auth"],
    ["502 + unknown", e(502, "graph_error", { draftStatus: "unknown" }), "unknown", "graph_error", false, "draft-send-unknown"],
    ["502 without draftStatus", e(502, "graph_error"), "unknown", "clone_anomaly", false, "draft-send-unknown"],
    ["503", e(503, "not_ready", { draftStatus: "saved" }), "saved", "clone_not_ready", true, "clone-anomaly"],
    ["504 + saved", e(504, "graph_timeout", { draftStatus: "saved" }), "saved", "timeout_nothing_sent", true, null],
    ["504 + unknown (C30)", e(504, "graph_timeout", { draftStatus: "unknown" }), "unknown", "timeout", false, "draft-send-unknown"],
    ["500", e(500, "server_error", { draftStatus: "unknown" }), "unknown", "clone_error", false, "draft-send-unknown"],
    ["500 without draftStatus", e(500, "server_error"), "unknown", "clone_error", false, "draft-send-unknown"],
    ["transport", e(null, null), "unknown", "transport", false, "draft-send-unknown"],
    ["DD timeout", e(null, null, {}, { code: "timeout" }), "unknown", "transport", false, "draft-send-unknown"],
    ["2xx invalid_body", e(202, null), "unknown", "clone_anomaly", false, "draft-send-unknown"],
    ["unknown_code on 4xx", e(418, "teapot"), "unknown", "clone_anomaly", false, "draft-send-unknown"],
    ["unknown_code on 5xx", e(599, "weird"), "unknown", "clone_anomaly", false, "draft-send-unknown"],
    ["edge page", e(503, null), "unknown", "clone_anomaly", false, "draft-send-unknown"],
    ["draftStatus creating is ignored", e(500, "server_error", { draftStatus: "creating" }), "unknown", "clone_error", false, "draft-send-unknown"]
  ];
  it.each(rows)("%s", (_label, outcome, to, code, reviewKept, alert) => {
    const t = send(outcome);
    expect(t.to).toBe(to);
    expect(t.code).toBe(code);
    expect(t.alert).toBe(alert);
    expect(t.reviewCleared).toBe(!reviewKept);
    if (reviewKept) expect(t.patch).not.toHaveProperty("review_hash");
    else expect(t.patch).toMatchObject({ review_hash: null, review_at: null });
    expect(t.patch).toMatchObject({ status: to, last_error_code: code });
    if (to === "unknown") expect(t.patch).toMatchObject({ check_count: 0, next_check_at: at(20_000) });
    if (to === "gone") expect(t.patch).toMatchObject({ gone_unconfirmed: true, next_check_at: at(2 * MIN) });
  });
  it("ST11: a 404 near a send is never 'not sent'; draftStatus outranks HTTP both ways; the K24 revert schedules the not-found follow-ups", () => {
    expect(send(e(404, "gone", { draftStatus: "gone" })).to).not.toBe("discarded");
    expect(send(e(404, "gone", { draftStatus: "deleted" })).to).toBe("gone");
    const revert = send(e(404, "gone", { draftStatus: "saved" }));
    expect(revert.to).toBe("saved");
    expect(revert.patch).toMatchObject({ last_error_code: "outlook_not_found", last_error_at: NOW.toISOString(), next_check_at: at(2 * MIN) });
    expect(send(e(429, "throttled", { draftStatus: "unknown" })).to).toBe("unknown");
    expect(send(e(500, "server_error", { draftStatus: "saved" })).to).toBe("saved");
    const get = mapGetResult(rowFor("sent_pending"), fail(cloneErr("get_draft", 404, "gone", { draftStatus: "sent_pending_verification" })), NOW);
    expect(get.to).toBe("sent_pending");
    const c30 = send(e(504, "graph_timeout", { draftStatus: "unknown" }));
    expect(c30.to).toBe("unknown");
    expect(c30.code).toBe("timeout");
    for (const t of rows.map(([, o]) => mapSendResult(sending(), o, NOW))) expect(t.to).not.toBe("sending");
  });
  it("a kept review keeps review_hash; 429 carries its Retry-After through the error", () => {
    const t = send(e(429, "throttled", { draftStatus: "saved" }));
    expect(t.patch).not.toHaveProperty("review_hash");
    expect((rows[18][1] as { error: CloneEaError }).error.retryAfterMs).toBe(30_000);
  });
});

describe("mapGetResult (the sweep's answers)", () => {
  it("a read goes through the mirror; an error with draftStatus too; the rest keep the state and schedule + 5 min with the row's alert", () => {
    const row = rowFor("sent_pending");
    const live = mapGetResult(row, ok<CloneDraftRead>(registryView("sent")), NOW);
    expect(live.to).toBe("sent");
    const byStatus = mapGetResult(row, fail(cloneErr("get_draft", 404, "gone", { draftStatus: "deleted" })), NOW);
    expect(byStatus.to).toBe("gone");
    expect(byStatus.code).toBe("gone");
    const nf = tx("get nf", row, mapGetResult(row, fail(cloneErr("get_draft", 404, "not_found")), NOW));
    expect(nf.to).toBe("sent_pending");
    expect(nf.alert).toBe("draft-registry-missing");
    expect(nf.patch).toMatchObject({ next_check_at: at(5 * MIN) });
    const auth = tx("get auth", row, mapGetResult(row, fail(cloneErr("get_draft", 401, "invalid_token")), NOW));
    expect(auth.alert).toBe("clone-ea-auth");
    expect(auth.code).toBe("ea_auth");
    expect(auth.patch).toMatchObject({ next_check_at: at(5 * MIN) });
    for (const r of [fail(cloneErr("get_draft", 429, "throttled")), fail(cloneErr("get_draft", 503, "not_ready")), fail(cloneErr("get_draft", null, null)), fail(cloneErr("get_draft", 502, null)), fail(cloneErr("get_draft", 200, null)), NO_ANSWER]) {
      const t = tx("get fail", row, mapGetResult(row, r as CloneAnswer<CloneDraftRead>, NOW));
      expect(t.to).toBe("sent_pending");
      expect(t.patch).toMatchObject({ next_check_at: at(5 * MIN) });
      expect(t.patch).not.toHaveProperty("status");
    }
  });

  it("an error carrying draftStatus saved never moves sending / unknown to saved (data-1): a failed check, the flag can't be known", () => {
    for (const src of ["unknown", "sending"] as const) {
      const row = rowFor(src);
      for (const e of [cloneErr("get_draft", 502, "graph_error", { draftStatus: "saved" }), cloneErr("get_draft", 429, "throttled", { draftStatus: "saved" }),
        cloneErr("get_draft", 503, "not_ready", { draftStatus: "saved" })]) {
        const t = tx(`get ${src} err saved`, row, mapGetResult(row, fail<CloneDraftRead>(e), NOW));
        expect(t.to, src).toBe(src);
        expect(t.patch).not.toHaveProperty("status");
        expect(t.patch).not.toHaveProperty("review_hash");
        expect(t.patch).toMatchObject({ next_check_at: at(5 * MIN) });
      }
    }
    // A real read with no flag still applies C15; a read with the flag keeps the row unknown.
    expect(mapGetResult(rowFor("unknown"), ok<CloneDraftRead>(readBack()), NOW).to).toBe("saved");
    expect(mapGetResult(rowFor("unknown"), ok<CloneDraftRead>(readBack({ flags: ["send_status_unknown"] })), NOW).to).toBe("unknown");
    // Other sources keep the §2.6 precedence rule: from saved an error-carried saved changes nothing.
    expect(mapGetResult(rowFor("saved"), fail<CloneDraftRead>(cloneErr("get_draft", 502, "graph_error", { draftStatus: "saved" })), NOW).to).toBe("saved");
  });
});

// ---------------------------------------------------------------------------
// ST12 nextCheckAt
// ---------------------------------------------------------------------------

describe("ST12 nextCheckAt", () => {
  const S1 = [20_000, 40_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000];
  it("S1 for check_count 0-12 on sent_pending and unknown, from their anchors, never in the past", () => {
    const accepted = at(-10_000);
    for (let n = 0; n <= 12; n += 1) {
      const expected = n < 9 ? Date.parse(accepted) + S1[n] : Date.parse(accepted) + S1[8] + (n - 8) * 3_600_000;
      const floor = NOW.getTime() + 20_000;
      const pending = nextCheckAt(rowFor("sent_pending", { sendAcceptedAt: accepted, checkCount: n }), NOW);
      expect(Date.parse(pending as string), `sent_pending n=${n}`).toBe(Math.max(expected, floor));
      const unknown = nextCheckAt(rowFor("unknown", { sendStartedAt: accepted, checkCount: n }), NOW);
      expect(Date.parse(unknown as string), `unknown n=${n}`).toBe(Math.max(expected, floor));
    }
  });
  it("sent_pending stops at 24 h (C16) and never schedules past it; unknown moves to every 6 h until 14 days, then null (C68)", () => {
    const anchor = at(-DRAFT_LIMITS.sentPendingMaxMs + 30 * MIN);
    expect(nextCheckAt(rowFor("sent_pending", { sendAcceptedAt: anchor, checkCount: 40 }), NOW)).toBe(at(30 * MIN));
    expect(nextCheckAt(rowFor("sent_pending", { sendAcceptedAt: at(-DRAFT_LIMITS.sentPendingMaxMs), checkCount: 40 }), NOW)).toBeNull();
    expect(nextCheckAt(rowFor("unknown", { sendStartedAt: at(-25 * 3_600_000), checkCount: 30 }), NOW)).toBe(at(6 * 3_600_000));
    expect(nextCheckAt(rowFor("unknown", { sendStartedAt: at(-13 * 86_400_000), checkCount: 30 }), NOW)).toBe(at(6 * 3_600_000));
    expect(nextCheckAt(rowFor("unknown", { sendStartedAt: at(-14 * 86_400_000), checkCount: 30 }), NOW)).toBeNull();
    expect(nextCheckAt(rowFor("unknown", { sendStartedAt: at(-13 * 86_400_000 - 20 * 3_600_000), checkCount: 30 }), NOW)).toBeNull();
    // A row that reached unknown without a send: anchored on created_at.
    expect(nextCheckAt(rowFor("unknown", { sendStartedAt: null, sendAttemptKey: null, confirmHash: null, checkCount: 0 }), NOW)).toBe(at(20_000));
  });
  it("a failed check -> + 5 min (until the anchor's 24 h, then the slow schedule)", () => {
    expect(nextCheckAt(rowFor("sent_pending"), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(rowFor("unknown"), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(rowFor("unknown", { sendStartedAt: at(-25 * 3_600_000) }), NOW, "failed")).toBe(at(6 * 3_600_000));
    expect(nextCheckAt(rowFor("saving"), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(rowFor("discarding"), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(rowFor("sending"), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(rowFor("gone"), NOW, "failed")).toBe(at(5 * MIN));
  });
  it("the stale timers: saving / discarding + 6 min, sending + 3 min, generating + 5 min", () => {
    expect(nextCheckAt(rowFor("saving", { saveStartedAt: NOW.toISOString() }), NOW)).toBe(at(6 * MIN));
    expect(nextCheckAt(rowFor("discarding", { discardStartedAt: NOW.toISOString() }), NOW)).toBe(at(6 * MIN));
    expect(nextCheckAt(rowFor("sending", { sendStartedAt: NOW.toISOString() }), NOW)).toBe(at(3 * MIN));
    expect(nextCheckAt(rowFor("generating"), NOW)).toBe(at(5 * MIN));
    // A stale timer already in the past still yields a future check.
    expect(nextCheckAt(rowFor("saving", { saveStartedAt: at(-10 * MIN) }), NOW)).toBe(at(5 * MIN));
  });
  it("gone re-checks at gone_at + 2 / 6 / 16 min; a failed third check -> + 5 min with the flag kept; the clearing is T35's (null once confirmed)", () => {
    const goneAt = at(-MIN);
    const g = (over: Partial<ExecDraftRow> = {}) => rowFor("gone", { goneAt, ...over });
    expect(nextCheckAt(g(), NOW)).toBe(at(MIN));
    expect(nextCheckAt(g({ goneAt: at(-3 * MIN) }), NOW)).toBe(at(3 * MIN));
    expect(nextCheckAt(g({ goneAt: at(-7 * MIN) }), NOW)).toBe(at(9 * MIN));
    expect(nextCheckAt(g({ goneAt: at(-16 * MIN) }), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(g({ goneAt: at(-17 * MIN) }), NOW)).toBe(at(5 * MIN));
    expect(nextCheckAt(g({ goneAt: at(-25 * 3_600_000) }), NOW, "failed")).toBe(at(6 * 3_600_000));
    expect(nextCheckAt(g({ goneAt: at(-15 * 86_400_000) }), NOW, "failed")).toBeNull();
    expect(nextCheckAt(g({ goneUnconfirmed: false }), NOW)).toBeNull();
    // T35's success rule: a mirror from gone that still answers gone changes nothing (the sweep clears the flag itself at >= +16 min).
    const late = mirrorRegistry(g({ goneAt: at(-16 * MIN) }), { status: "gone", flags: [], read: null }, NOW);
    expect(late.patch).not.toHaveProperty("gone_unconfirmed");
  });
  it("Open in Outlook follow-ups on saved and linked draft rows: + 25 s / 2 min / 10 min from opened_in_outlook_at (C69)", () => {
    const opened = at(-10_000);
    expect(nextCheckAt(rowFor("saved", { openedInOutlookAt: opened }), NOW)).toBe(at(15_000));
    expect(nextCheckAt(rowFor("saved", { openedInOutlookAt: at(-30_000) }), NOW)).toBe(at(90_000));
    expect(nextCheckAt(rowFor("saved", { openedInOutlookAt: at(-3 * MIN) }), NOW)).toBe(at(7 * MIN));
    expect(nextCheckAt(rowFor("saved", { openedInOutlookAt: at(-11 * MIN) }), NOW)).toBeNull();
    expect(nextCheckAt(rowFor("draft", { ...LINK, savedVersion: 1, openedInOutlookAt: opened }), NOW)).toBe(at(15_000));
    expect(nextCheckAt(rowFor("draft", { openedInOutlookAt: opened }), NOW)).toBeNull();
    expect(nextCheckAt(rowFor("saved", { openedInOutlookAt: at(-3 * MIN) }), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(rowFor("saved", { openedInOutlookAt: at(-11 * MIN) }), NOW, "failed")).toBe(at(5 * MIN));
    expect(nextCheckAt(rowFor("saved", { openedInOutlookAt: at(-25 * 3_600_000) }), NOW, "failed")).toBeNull();
  });
  it("outlook_not_found follow-ups: last_error_at + 2 / 6 / 16 min; the earlier of the two schedules wins", () => {
    expect(nextCheckAt(rowFor("saved", { lastErrorCode: "outlook_not_found", lastErrorAt: at(-MIN) }), NOW)).toBe(at(MIN));
    expect(nextCheckAt(rowFor("saved", { lastErrorCode: "outlook_not_found", lastErrorAt: at(-5 * MIN) }), NOW)).toBe(at(MIN));
    expect(nextCheckAt(rowFor("saved", { lastErrorCode: "outlook_not_found", lastErrorAt: at(-10 * MIN) }), NOW)).toBe(at(6 * MIN));
    expect(nextCheckAt(rowFor("saved", { lastErrorCode: "outlook_not_found", lastErrorAt: at(-17 * MIN) }), NOW)).toBeNull();
    expect(nextCheckAt(rowFor("saved", { lastErrorCode: "throttled", lastErrorAt: at(-MIN) }), NOW)).toBeNull();
    expect(nextCheckAt(rowFor("saved", { lastErrorCode: "outlook_not_found", lastErrorAt: at(-MIN), openedInOutlookAt: at(-10_000) }), NOW)).toBe(at(15_000));
  });
  it("null for settled states", () => {
    for (const s of ["generation_failed", "sent", "sent_external", "discarded"] as const) expect(nextCheckAt(rowFor(s), NOW), s).toBeNull();
    expect(nextCheckAt(rowFor("saved"), NOW)).toBeNull();
    expect(nextCheckAt(rowFor("draft"), NOW)).toBeNull();
  });
  it("checkedPatch bumps check_count and recomputes next_check_at on the resulting row", () => {
    const row = rowFor("sent_pending", { sendAcceptedAt: at(-10_000), checkCount: 1 });
    const t = mirrorRegistry(row, { status: "sent_pending_verification", flags: [], read: registryView("sent_pending_verification") }, NOW);
    const p = checkedPatch(row, t, NOW, "ok");
    expect(p.check_count).toBe(2);
    expect(p.next_check_at).toBe(at(50_000));
    const failed = checkedPatch(row, t, NOW, "failed");
    expect(failed.next_check_at).toBe(at(5 * MIN));
    const settled = checkedPatch(row, mirrorRegistry(row, { status: "sent", flags: [], read: registryView("sent") }, NOW), NOW, "ok");
    expect(settled.next_check_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ST13-ST15
// ---------------------------------------------------------------------------

describe("ST13 canOfferNewReply", () => {
  const offer = (row: ExecDraftRow, sentCopy: "found" | "not_found" | "unsupported", checkedOutlook: boolean) =>
    canOfferNewReply(row, { sentCopy, checkedOutlook, now: NOW });
  it("every branch", () => {
    expect(offer(rowFor("discarded"), "found", true)).toEqual({ ok: false, code: "sent_copy_found" });
    expect(offer(rowFor("sending"), "not_found", true)).toEqual({ ok: false, code: "state_conflict" });
    expect(offer(rowFor("sent_pending"), "not_found", true)).toEqual({ ok: false, code: "state_conflict" });
    expect(offer(rowFor("unknown", { sendStartedAt: at(-10 * MIN) }), "not_found", true)).toEqual({ ok: false, code: "hold" });
    expect(offer(rowFor("unknown", { sendStartedAt: at(-10 * MIN), cloneFlags: ["send_status_unknown"] }), "not_found", true)).toEqual({ ok: false, code: "hold" });
    expect(offer(rowFor("unknown"), "not_found", false)).toEqual({ ok: false, code: "hold" });
    expect(offer(rowFor("unknown"), "not_found", true)).toEqual({ ok: true });
    expect(offer(rowFor("gone"), "not_found", false)).toEqual({ ok: false, code: "hold" });
    expect(offer(rowFor("gone", { goneUnconfirmed: false }), "not_found", false)).toEqual({ ok: false, code: "hold" });
    expect(offer(rowFor("gone"), "not_found", true)).toEqual({ ok: true });
    expect(offer(rowFor("discarded"), "unsupported", false)).toEqual({ ok: false, code: "hold" });
    expect(offer(rowFor("discarded"), "unsupported", true)).toEqual({ ok: true });
    expect(offer(rowFor("discarded"), "not_found", false)).toEqual({ ok: true });
    expect(offer(rowFor("gone", { goneUnconfirmed: false }), "unsupported", true)).toEqual({ ok: true });
  });
});

describe("ST14 reviewIsValid", () => {
  it("no hash; exactly 600 000 ms valid, + 1 ms not; opened in Outlook after the review -> invalid", () => {
    expect(reviewIsValid(rowFor("saved", { reviewHash: null, reviewAt: null }), NOW)).toBe(false);
    expect(reviewIsValid(rowFor("saved", { reviewAt: at(-600_000) }), NOW)).toBe(true);
    expect(reviewIsValid(rowFor("saved", { reviewAt: at(-600_001) }), NOW)).toBe(false);
    expect(reviewIsValid(rowFor("saved", { reviewAt: at(-2 * MIN), openedInOutlookAt: at(-MIN) }), NOW)).toBe(false);
    expect(reviewIsValid(rowFor("saved", { reviewAt: at(-MIN), openedInOutlookAt: at(-MIN) }), NOW)).toBe(true);
    expect(reviewIsValid(rowFor("saved", { reviewAt: at(-MIN), openedInOutlookAt: at(-2 * MIN) }), NOW)).toBe(true);
  });
});

describe("ST15 computeReviewBlockers", () => {
  const msg = (over: Partial<HisMessage>): HisMessage => ({
    id: "m_x", threadId: "th_1", accountId: "acc_1", direction: "inbound", folder: "Inbox", isJunk: false, rfcMessageId: null, inReplyTo: null,
    subject: "Re", from: { email: "a@client.com", name: "Ann" } as HisMessage["from"], to: [], cc: [], sentAt: at(-30 * MIN), createdAtMs: null,
    isAutomated: false, attachments: [], bodyDeferred: false, bodyHtml: null, bodyText: null, ...over
  });
  const thread = (his: HisMessage[]): PrincipalMailThread =>
    ({ threadId: "th_1", participants: [], his, all: [], snapshot: { identityCount: 0, maxCreatedAtMs: null, maxSentAtMs: null, readStartedAtMs: 0, readDoneAtMs: 0 }, lastMessageAt: null });
  const parent = msg({ id: "m_1", sentAt: at(-60 * MIN) });
  const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
    draftCreatedAtMs: NOW.getTime() - 20 * MIN, generatedAtMs: NOW.getTime() - 15 * MIN, parentMessageId: "m_1", replyMode: "reply",
    parentSentAtMs: NOW.getTime() - 60 * MIN, thread: thread([parent]), ownAddresses: new Set(["mitchell@scaledai.org"]), legacyArtifacts: null,
    siblingDrafts: [], openedInOutlookAt: null, storedContentHash: HEX("c"), readBackContentHash: HEX("c"), storedSig: HEX("1"), readBackSig: HEX("1"),
    readBackReplyToCount: 0, ownPartPlaceholders: [], ddPlaceholders: [], factsOutsideClient: false, generationFlags: [], usesPrivateRefs: false, ...over
  });
  it("no blockers on a clean review; new drafts produce no thread blockers", () => {
    expect(computeReviewBlockers(facts())).toEqual([]);
    expect(computeReviewBlockers(facts({ thread: null, parentMessageId: null, replyMode: null, parentSentAtMs: null }))).toEqual([]);
  });
  it("already_replied: an outbound after the parent's sentAt, even before the draft existed (security-2); not before the parent; follow-up mode keys on created_at", () => {
    const reply = msg({ id: "m_2", direction: "outbound", from: { email: "mitchell@scaledai.org", name: "M" } as HisMessage["from"], sentAt: at(-40 * MIN) });
    expect(computeReviewBlockers(facts({ thread: thread([parent, reply]) }))).toEqual(["already_replied"]);
    const earlier = msg({ ...reply, sentAt: at(-70 * MIN) });
    expect(computeReviewBlockers(facts({ thread: thread([parent, earlier]) }))).toEqual([]);
    const junk = msg({ ...reply, isJunk: true });
    const automated = msg({ ...reply, isAutomated: true });
    expect(computeReviewBlockers(facts({ thread: thread([parent, junk, automated]) }))).toEqual([]);
    // parentSentAtMs unknown: measured from created_at.
    expect(computeReviewBlockers(facts({ parentSentAtMs: null, thread: thread([parent, reply]) }))).toEqual([]);
    expect(computeReviewBlockers(facts({ parentSentAtMs: null, thread: thread([parent, msg({ ...reply, sentAt: at(-10 * MIN) })]) }))).toEqual(["already_replied"]);
    // follow-up: the parent is his own outbound; only an outbound after the draft began counts.
    const own = msg({ id: "m_1", direction: "outbound", sentAt: at(-60 * MIN) });
    expect(computeReviewBlockers(facts({ replyMode: "follow_up", thread: thread([own, msg({ ...reply, id: "m_3", sentAt: at(-30 * MIN) })]) }))).toEqual([]);
    expect(computeReviewBlockers(facts({ replyMode: "follow_up", thread: thread([own, msg({ ...reply, id: "m_3", sentAt: at(-10 * MIN) })]) }))).toEqual(["already_replied"]);
  });
  it("already_replied from a sibling draft in each sending-or-sent status, and not from discarded", () => {
    for (const status of ["sending", "sent_pending", "unknown", "sent", "sent_external", "gone"] as const) {
      expect(computeReviewBlockers(facts({ siblingDrafts: [{ status }] })), status).toEqual(["already_replied"]);
    }
    for (const status of ["discarded", "draft", "saved", "generating"] as const) {
      expect(computeReviewBlockers(facts({ siblingDrafts: [{ status }] })), status).toEqual([]);
    }
  });
  it("newer_inbound: a qualifying inbound newer than generated_at (or created_at) that isn't the parent; junk and self-copies don't count", () => {
    const newer = msg({ id: "m_9", sentAt: at(-5 * MIN) });
    expect(computeReviewBlockers(facts({ thread: thread([parent, newer]) }))).toEqual(["newer_inbound"]);
    expect(computeReviewBlockers(facts({ thread: thread([parent, msg({ ...newer, isJunk: true })]) }))).toEqual([]);
    expect(computeReviewBlockers(facts({ thread: thread([parent, msg({ ...newer, from: { email: "mitchell@scaledai.org", name: "M" } as HisMessage["from"] })]) }))).toEqual([]);
    expect(computeReviewBlockers(facts({ thread: thread([parent, msg({ ...newer, sentAt: at(-18 * MIN) })]) }))).toEqual([]);
    expect(computeReviewBlockers(facts({ generatedAtMs: null, thread: thread([parent, msg({ ...newer, sentAt: at(-18 * MIN) })]) }))).toEqual(["newer_inbound"]);
  });
  it("each other blocker alone, then all combined in REVIEW_BLOCKERS order", () => {
    expect(computeReviewBlockers(facts({ legacyArtifacts: { scheduledFor: at(60 * MIN), draftPending: false } }))).toEqual(["reply_scheduled"]);
    expect(computeReviewBlockers(facts({ legacyArtifacts: { scheduledFor: null, draftPending: true } }))).toEqual(["legacy_draft_pending"]);
    expect(computeReviewBlockers(facts({ openedInOutlookAt: at(-MIN) }))).toEqual(["opened_in_outlook"]);
    expect(computeReviewBlockers(facts({ readBackContentHash: HEX("e") }))).toEqual(["changed_in_outlook"]);
    expect(computeReviewBlockers(facts({ storedContentHash: null, readBackContentHash: HEX("e") }))).toEqual([]);
    expect(computeReviewBlockers(facts({ readBackSig: HEX("2") }))).toEqual(["recipients_changed"]);
    expect(computeReviewBlockers(facts({ readBackReplyToCount: 1 }))).toEqual(["reply_to_present"]);
    expect(computeReviewBlockers(facts({ ownPartPlaceholders: ["[name]"], ddPlaceholders: [] }))).toEqual(["placeholder_in_outlook"]);
    expect(computeReviewBlockers(facts({ ownPartPlaceholders: ["[name]"], ddPlaceholders: ["[name]"] }))).toEqual([]);
    expect(computeReviewBlockers(facts({ thread: "unavailable" }))).toEqual(["thread_unavailable"]);
    expect(computeReviewBlockers(facts({ factsOutsideClient: true }))).toEqual(["facts_outside_client"]);
    expect(computeReviewBlockers(facts({ generationFlags: ["unexpected_url"] }))).toEqual(["unexpected_content"]);
    const everything = computeReviewBlockers(facts({
      thread: thread([parent, msg({ id: "m_2", direction: "outbound", sentAt: at(-40 * MIN) }), msg({ id: "m_9", sentAt: at(-5 * MIN) })]),
      legacyArtifacts: { scheduledFor: at(60 * MIN), draftPending: true }, openedInOutlookAt: at(-MIN), readBackContentHash: HEX("e"), readBackSig: HEX("2"),
      readBackReplyToCount: 2, ownPartPlaceholders: ["[x]"], factsOutsideClient: true, generationFlags: ["teammate_name"]
    }));
    const all: ReviewBlocker[] = ["already_replied", "newer_inbound", "reply_scheduled", "legacy_draft_pending", "opened_in_outlook", "changed_in_outlook",
      "recipients_changed", "reply_to_present", "placeholder_in_outlook", "facts_outside_client", "unexpected_content"];
    expect(everything).toEqual(all);
  });
  // P5b F4 / F12 (C45): the second confirmation for a draft started in a chat that read other private material.
  it("private_refs exactly when the row uses private refs, last in REVIEW_BLOCKERS order (TF4)", () => {
    expect(computeReviewBlockers(facts({ usesPrivateRefs: true }))).toEqual(["private_refs"]);
    expect(computeReviewBlockers(facts({ usesPrivateRefs: false }))).toEqual([]);
    expect(computeReviewBlockers(facts({ thread: null, parentMessageId: null, replyMode: null, parentSentAtMs: null, usesPrivateRefs: true }))).toEqual(["private_refs"]);
    expect(computeReviewBlockers(facts({ usesPrivateRefs: true, generationFlags: ["unexpected_url"], openedInOutlookAt: at(-MIN) })))
      .toEqual(["opened_in_outlook", "unexpected_content", "private_refs"]);
    expect(REVIEW_BLOCKERS).toHaveLength(13);
    expect(REVIEW_BLOCKERS[12]).toBe("private_refs");
    // The fake's CHECK subset (§2.1's re-added constraint) takes it, and still refuses an unknown value.
    expect(checkDraftRow(snakeOf(base({ reviewBlockers: ["private_refs"] })))).toEqual([]);
    expect(checkDraftRow({ ...snakeOf(base()), review_blockers: ["no_such_blocker"] })).toContain("exec_drafts_review_blockers_check");
  });
});

// ---------------------------------------------------------------------------
// ST16-ST20
// ---------------------------------------------------------------------------

describe("ST16 every patch satisfies §2.1's CHECKs", () => {
  it("across every transition the tests above produced, plus the terminal and purge helpers", () => {
    produced.push({ label: "T36", row: rowFor("draft"), t: { to: "discarded", patch: terminalPatch(rowFor("draft"), "discarded", NOW), code: null, alert: null, reviewCleared: true } });
    produced.push({ label: "T42", row: rowFor("unknown"), t: { to: "sent", patch: { ...terminalPatch(rowFor("unknown"), "sent", NOW), owner_resolution: "sent", unverified: true }, code: null, alert: null, reviewCleared: true } });
    produced.push({ label: "T46", row: rowFor("gone"), t: { to: "sent", patch: { ...terminalPatch(rowFor("gone"), "sent", NOW), owner_resolution: "sent", unverified: true }, code: null, alert: null, reviewCleared: true } });
    expect(produced.length).toBeGreaterThan(150);
    for (const { label, row, t } of produced) {
      const before = checkDraftRow(snakeOf(row));
      expect(before, `${label}: the source row itself (${row.status})`).toEqual([]);
      const after = applyDraftPatch(row, t.patch);
      expect(after.status, label).toBe(t.to);
      expect(checkDraftRow(snakeOf(after)), `${label}: ${row.status} -> ${t.to}`).toEqual([]);
    }
  });
  it("terminalPatch sets terminal_at, expires_at from the retention, clears the schedule and the review", () => {
    const p = terminalPatch(rowFor("draft"), "discarded", NOW, { retentionDays: 30 });
    expect(p).toMatchObject({ status: "discarded", terminal_at: NOW.toISOString(), expires_at: at(30 * 86_400_000), next_check_at: null, review_hash: null, gone_unconfirmed: false, prior_status: null });
    expect(terminalPatch(rowFor("draft"), "discarded", NOW).expires_at).toBe(at(180 * 86_400_000));
  });
});

describe("ST17 the discard's origin (C76)", () => {
  it("priorStatusOf: saved stays saved when current, becomes draft when the version moved on, unknown stays unknown; a purged row keeps saved", () => {
    expect(priorStatusOf(rowFor("discarding", { priorStatus: "saved" }))).toBe("saved");
    expect(priorStatusOf(rowFor("discarding", { priorStatus: "saved", savedVersion: 1 }))).toBe("draft");
    expect(priorStatusOf(rowFor("discarding", { priorStatus: "saved", savedVersion: 1, restrictedPurged: true }))).toBe("saved");
    expect(priorStatusOf(rowFor("discarding", { priorStatus: "unknown" }))).toBe("unknown");
    expect(priorStatusOf(rowFor("discarding", { priorStatus: "draft" }))).toBe("draft");
    expect(priorStatusOf(rowFor("discarding", { priorStatus: null }))).toBe("saved");
    expect(priorStatusOf(rowFor("discarding", { priorStatus: null, savedVersion: 1 }))).toBe("draft");
  });
  it("leaving discarding writes prior_status = null (every answer); a T43 discard returns to unknown on failure and records not_sent on success", () => {
    const t43 = rowFor("discarding", { priorStatus: "unknown", ...SEND });
    const back = mapDeleteResult(t43, fail(cloneErr("delete", 500, "server_error")), NOW);
    expect(isTransition(back) && back.to).toBe("unknown");
    expect(isTransition(back) && back.patch).toMatchObject({ prior_status: null, status: "unknown" });
    const changed = mapDeleteResult(t43, fail(cloneErr("delete", 409, "changed", { draftStatus: "saved" })), NOW);
    expect(isTransition(changed) && changed.to).toBe("unknown");
    const throttled = mapDeleteResult(t43, fail(cloneErr("delete", 429, "throttled")), NOW);
    expect(isTransition(throttled) && throttled.to).toBe("unknown");
    const done = mapDeleteResult(t43, ok({ graphId: GRAPH, status: "deleted" as const }), NOW);
    expect(isTransition(done) && done.patch).toMatchObject({ status: "discarded", owner_resolution: "not_sent", prior_status: null });
    const stale = mirrorRegistry(rowFor("discarding"), { status: "saved", flags: [], read: readBack() }, NOW);
    expect(stale.patch).toMatchObject({ prior_status: null });
  });
});

describe("ST18 auditCode", () => {
  it("maps every DraftErrorCode, CloneEaErrorKind, §2.6 code and RecipientError to itself; anything else to other", () => {
    const codes = ["not_found", "forbidden", "bad_request", "invalid", "drafts_off", "send_off", "drafts_unavailable", "send_unavailable", "rate_limited",
      "version_conflict", "state_conflict", "review_required", "review_expired", "acks_missing", "recipients_blocked", "placeholders", "empty_body",
      "unsafe_markup", "instruction_required", "subject_required", "thread_unavailable", "mailbox_problem", "audit_unavailable", "unavailable", "hold", "sent_copy_found",
      "auth", "send_disabled", "mailbox_not_connected", "gone", "changed", "already_sending", "already_sent", "sent_externally", "parent_missing",
      "idempotency_mismatch", "throttled", "mailbox_reconnect", "graph_error", "not_ready", "graph_timeout", "server_error", "edge", "unknown_code",
      "invalid_body", "transport", "timeout",
      "outcome_unknown", "ea_auth", "thread_not_found", "account_not_found", "clone_not_ready", "clone_error", "outlook_changed", "recreate_failed",
      "not_in_registry", "accepted", "clone_anomaly", "timeout_nothing_sent", "outlook_not_found", "outlook_unknown", "outlook_unknown_restricted",
      "outlook_reappeared", "expired_idle", "generation_stopped", "generation_declined", "generation_timeout", "not_saved",
      "empty_to", "invalid_address", "own_address", "no_reply_address", "restricted_recipient", "too_many", "not_allowed", "to_not_derived",
      "bcc_on_reply", "from_mismatch", "sender_mismatch", "reply_to_restricted", "facts_recipient"];
    for (const c of codes) expect(auditCode(c), c).toBe(c);
    expect(auditCode("Bearer eyJ.token")).toBe("other");
    expect(auditCode("hello world")).toBe("other");
    expect(auditCode(new Error("boom"))).toBe("other");
    expect(auditCode(undefined)).toBe("other");
    expect(auditCode(null)).toBe("other");
    expect(auditCode("x".repeat(500))).toBe("other");
    expect(auditCode("generation_whatever")).toBe("other");
  });
});

describe("ST19 the §2.6 precedence rule", () => {
  const statuses: CloneDraftStatus[] = ["saved", "sending", "sent_pending_verification", "sent", "sent_mismatch", "sent_external", "unknown", "gone", "deleted"];
  const answers: [CloneEaRoute, number, string][] = [
    ["recreate", 409, "changed"], ["recreate", 409, "already_sending"], ["recreate", 409, "already_sent"], ["recreate", 404, "gone"], ["recreate", 502, "graph_error"],
    ["delete", 409, "already_sending"], ["delete", 409, "already_sent"], ["delete", 404, "gone"], ["delete", 500, "server_error"],
    ["send", 409, "changed"], ["send", 409, "already_sending"], ["send", 409, "already_sent"], ["send", 404, "gone"], ["send", 502, "graph_error"], ["send", 504, "graph_timeout"], ["send", 500, "server_error"],
    ["get_draft", 404, "gone"], ["get_draft", 409, "already_sent"]
  ];
  const sourceOf = (route: CloneEaRoute): ExecDraftRow =>
    route === "recreate" ? RECREATING() : route === "delete" ? rowFor("discarding") : route === "send" ? rowFor("sending") : rowFor("sent_pending");
  const apply = (route: CloneEaRoute, row: ExecDraftRow, err: CloneEaError): ExecDraftStatus | null => {
    if (route === "recreate") {
      const r = mapReplayResult(row, "recreate", fail(err), NOW);
      return isTransition(r) ? r.to : "leaveSaving" in r ? "saving" : null;
    }
    if (route === "delete") {
      const r = mapDeleteResult(row, fail(err), NOW);
      return isTransition(r) ? r.to : "discarding";
    }
    if (route === "send") return mapSendResult(row, { kind: "error", error: err }, NOW).to;
    return mapGetResult(row, fail(err), NOW).to;
  };
  it("with a draftStatus the target equals §2.6.0's for the source status; every unlisted answer maps to the route's no-answer row", () => {
    for (const [route, http, code] of answers) {
      for (const ds of statuses) {
        const row = sourceOf(route);
        const expected = mirrorRegistry(row, { status: ds, flags: [], read: null }, NOW).to;
        const got = apply(route, row, cloneErr(route, http, code, { draftStatus: ds }));
        if (route === "delete" && code === "changed") continue;
        if (route === "delete" && code === "gone" && ds === "deleted") expect(got, `${route} ${http} ${code} + ${ds}`).toBe("discarded");
        else expect(got, `${route} ${http} ${code} + ${ds}`).toBe(expected);
      }
    }
    // The no-answer rows: saving stays saving, discarding stays discarding, a send becomes unknown, a GET keeps its state.
    for (const err of [cloneErr("recreate", 418, "teapot"), cloneErr("recreate", 502, null), cloneErr("recreate", 200, null)]) {
      expect(apply("recreate", RECREATING(), err)).toBe("saving");
    }
    for (const err of [cloneErr("delete", 418, "teapot"), cloneErr("delete", 502, null), cloneErr("delete", 200, null)]) {
      expect(apply("delete", rowFor("discarding"), err)).toBe("discarding");
    }
    for (const err of [cloneErr("send", 418, "teapot"), cloneErr("send", 502, null), cloneErr("send", 200, null)]) {
      expect(apply("send", rowFor("sending"), err)).toBe("unknown");
    }
    for (const err of [cloneErr("get_draft", 418, "teapot"), cloneErr("get_draft", 502, null), cloneErr("get_draft", 200, null)]) {
      expect(apply("get_draft", rowFor("sent_pending"), err)).toBe("sent_pending");
    }
    // A create from saving has no link to mirror onto: a bodiless draftStatus leaves it saving as an anomaly.
    const create = mapCreateResult(SAVING(), fail(cloneErr("create_reply", 409, "already_sending", { draftStatus: "sending" })), NOW);
    expect(create.to).toBe("saving");
    expect(create.code).toBe("clone_anomaly");
  });
});

describe("ST20 the overwrite guard (C66)", () => {
  it("mirrorRegistry and every sweep / check / resolution transition write observed_content_hash, never content_hash; only the save results (T18/T19 and the replay's re-GET of a saving row) and T27 / T47 write it", () => {
    const writers: string[] = [];
    for (const { label, row, t } of produced) {
      if ("content_hash" in t.patch) writers.push(`${label}:${row.status}->${t.to}`);
    }
    expect(writers.every((w) => /^(create|saving \+ saved|saving \+ sent_pending_verification|resolve replaced):saving->/.test(w) || /^resolve replaced/.test(w)), writers.join(", ")).toBe(true);
    for (const src of ["saved", "sending", "sent_pending", "unknown", "gone", "discarding"] as const) {
      for (const s of ["saved", "sending", "sent_pending_verification", "sent", "sent_external", "unknown", "gone", "deleted"] as const) {
        const t = mirrorRegistry(rowFor(src), { status: s, flags: [], read: s === "saved" ? readBack({ contentHash: HEX("e") }) : registryView(s) }, NOW);
        expect(t.patch, `${src} + ${s}`).not.toHaveProperty("content_hash");
        if (s === "saved" && t.to !== "gone") expect(t.patch.observed_content_hash, `${src} + saved observed`).toBe(HEX("e"));
      }
    }
    const check = mapGetResult(rowFor("saved"), ok<CloneDraftRead>(readBack({ contentHash: HEX("e") })), NOW);
    expect(check.patch).toMatchObject({ observed_content_hash: HEX("e") });
    expect(check.patch).not.toHaveProperty("content_hash");
    const replaced = resolveRecreateByGet(RECREATING(), fail(cloneErr("get_draft", 404, "gone", { draftStatus: "deleted", replacedBy: "NEW" })), ok<CloneDraftRead>(readBack({ graphId: "NEW" })), "x", NOW);
    expect(isTransition(replaced) && replaced.patch).not.toHaveProperty("content_hash");
  });
  it("DraftView.outlook.changedSinceSaved is true exactly when both hashes are set and differ (draftAttention's outlook_changed)", () => {
    expect(draftAttention(rowFor("saved"))).toBeNull();
    expect(draftAttention(rowFor("saved", { observedContentHash: HEX("e") }))).toBe("outlook_changed");
    expect(draftAttention(rowFor("saved", { observedContentHash: null }))).toBeNull();
    expect(draftAttention(rowFor("saved", { contentHash: null, observedContentHash: HEX("e") }))).toBeNull();
    expect(draftAttention(rowFor("draft", { ...LINK, savedVersion: 1, lastErrorCode: "outlook_changed" }))).toBe("outlook_changed");
    expect(draftAttention(rowFor("draft", { ...LINK, savedVersion: 1 }))).toBe("stale_link");
    expect(draftAttention(rowFor("unknown"))).toBe("unknown");
    expect(draftAttention(rowFor("sent", { sentMismatch: true }))).toBe("sent_mismatch");
    expect(draftAttention(rowFor("gone"))).toBe("gone_unconfirmed");
    expect(draftAttention(rowFor("generation_failed"))).toBe("generation_failed");
    expect(draftAttention(rowFor("saved", { restrictedPurged: true }))).toBe("restricted");
    expect(draftAttention(rowFor("sent"))).toBeNull();
  });
});

// A resolve action list the guards know, for the capabilities' order.
const RESOLVE_ORDER: ResolveAction[] = ["check", "mark_sent", "not_sent_new_draft", "copy_to_new_draft", "keep_outlook_version", "stop_generation"];
describe("capabilities order", () => {
  it("lists resolve actions in a fixed order", () => {
    const c = capabilitiesFor(rowFor("unknown"), { ...CTX, draftsUnavailable: null, sendUnavailable: null });
    expect(c.resolve).toEqual(RESOLVE_ORDER.filter((a) => c.resolve.includes(a)));
  });
});
