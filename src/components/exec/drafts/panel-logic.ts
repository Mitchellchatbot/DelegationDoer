import type { EmailDocNode } from "@/lib/email-doc";
import type { DraftAddress, DraftView, ExecDraftStatus, ReadBackView, ReviewBlocker, ReviewResult } from "@/lib/exec/drafts-types";
import { draftPageHref } from "@/lib/exec/drafts-links";
import type { DraftUiAction } from "./actions";
import { codeSentence, GENERIC_FAILURE_SENTENCE, recipientEntry, ROUTE_CODE_SENTENCE } from "./copy";

// What DraftPanel sends for each action and what it makes of the answer
// (P4 contract §3.12.3 R2-R12, §3.13.3/§3.13.4). Pure: no fetch, no React,
// so the mapping is unit-tested in node. The panel owns the I/O and the
// state; this file owns the shapes.
//
// The browser sends TipTap JSON, recipients and flags only (L7): never HTML,
// never a hash it computed. A seenContentHash is always the contentHash of a
// read-back the server returned and the panel showed (C53, C66).

export const DRAFTS_API = "/api/exec/drafts";

export type PanelMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface PanelRequest {
  method: PanelMethod;
  path: string;
  body?: Record<string, unknown>;
}

const draftPath = (id: string, tail = ""): string => `${DRAFTS_API}/${encodeURIComponent(id)}${tail}`;

/** An empty body for "Write it myself" on a failed first generation (T15: an edit with a body). */
export const EMPTY_BODY_DOC: EmailDocNode = Object.freeze({ type: "doc", content: [{ type: "paragraph" }] }) as EmailDocNode;

export interface ActionContext {
  view: DraftView;
  /** The version the queue knows (the newest PATCH answer or the view). */
  version: number;
  /** The panel's instruction box (regenerate); null when it is empty. */
  instruction: string | null;
  /** The read-back the panel is showing (the Outlook version after a check or a 409 `changed`), or null. */
  shownReadBack: ReadBackView | null;
  /**
   * P5b F5 (C45, additive): he ticked "I've checked it" on a draft started in a chat that read other private
   * material (view.usesPrivateRefs): a save posts confirmPrivate: true. Otherwise none is sent and the server asks.
   */
  confirmPrivate?: boolean;
  /**
   * P5b F5 (C44, additive): the box still holds the instruction the chat assistant wrote, unchanged. A regenerate then
   * sends no instruction, so the stored one stays the assistant's (the server marks any instruction it is sent his own).
   */
  keepInstruction?: boolean;
}

/** The request an action sends on an existing draft, or null when it has none (open_in_outlook and the create actions). */
export function requestFor(action: DraftUiAction, ctx: ActionContext): PanelRequest | null {
  const { view, version } = ctx;
  const seen = ctx.shownReadBack?.contentHash;
  const confirmed = ctx.confirmPrivate === true ? { confirmPrivate: true } : {};
  const resolve = (body: Record<string, unknown>): PanelRequest => ({ method: "POST", path: draftPath(view.id, "/resolve"), body });
  switch (action) {
    case "generate":
    case "regenerate":
      return { method: "POST", path: draftPath(view.id, "/regenerate"), body: ctx.keepInstruction === true ? { version } : { version, instruction: ctx.instruction } };
    case "write_myself":
      // generation_failed -> draft through an edit with a body (T15).
      return { method: "PATCH", path: draftPath(view.id), body: { version, bodyDoc: EMPTY_BODY_DOC } };
    case "save":
      return { method: "POST", path: draftPath(view.id, "/save"), body: { version, ...confirmed } };
    case "replace_with_dd":
      return seen ? { method: "POST", path: draftPath(view.id, "/save"), body: { version, seenContentHash: seen, ...confirmed } } : null;
    case "review":
      return { method: "POST", path: draftPath(view.id, "/review"), body: { version } };
    case "discard":
      return { method: "DELETE", path: draftPath(view.id), body: { version } };
    case "delete_anyway":
      return seen ? { method: "DELETE", path: draftPath(view.id), body: { version, seenContentHash: seen } } : null;
    case "delete_restricted":
      return { method: "DELETE", path: draftPath(view.id), body: { version, confirmRestrictedDelete: true } };
    case "check_again":
    case "show_outlook_version":
    case "resolve:check":
      return resolve({ action: "check" });
    case "stop":
    case "resolve:stop_generation":
      return resolve({ action: "stop_generation" });
    case "resolve:mark_sent":
      return resolve({ action: "mark_sent", checkedOutlook: true });
    case "resolve:copy_to_new_draft":
      return resolve({ action: "copy_to_new_draft", checkedOutlook: true });
    case "resolve:not_sent_new_draft":
      return resolve(seen ? { action: "not_sent_new_draft", checkedOutlook: true, seenContentHash: seen } : { action: "not_sent_new_draft", checkedOutlook: true });
    case "resolve:keep_outlook_version":
      return seen ? resolve({ action: "keep_outlook_version", seenContentHash: seen }) : null;
    case "open_in_outlook":
      return null;
  }
}

/** The outlook-opened stamp (R11), sent by the Open-in-Outlook button before it navigates (C69). */
export const outlookOpenedRequest = (id: string): PanelRequest => ({ method: "POST", path: draftPath(id, "/outlook-opened"), body: {} });
/** The live send probe (R9; display only). */
export const sendProbeRequest = (id: string): PanelRequest => ({ method: "GET", path: draftPath(id, "/send") });

/**
 * P9 F24: the send probe's answer (GET …/send: { sendReady, reason, draftsReady }) as the panel keeps it. sendReady null =
 * unknown (not a 200, or no boolean); reason only when sendReady is false and it is a short code (the hint's words).
 */
export function sendProbeAnswer(status: number, json: unknown): { sendReady: boolean | null; reason: string | null } {
  const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const sendReady = status === 200 && typeof o.sendReady === "boolean" ? o.sendReady : null;
  const reason = sendReady === false && typeof o.reason === "string" && /^[a-z_]{1,40}$/.test(o.reason) ? o.reason : null;
  return { sendReady, reason };
}
export const viewRequest = (id: string): PanelRequest => ({ method: "GET", path: draftPath(id) });

/** An autosave PATCH (R4): the editor's JSON and the recipient fields its kind allows. */
export function editRequest(view: Pick<DraftView, "id" | "kind">, version: number, edit: DraftEdit): PanelRequest {
  const body: Record<string, unknown> = { version };
  if (edit.bodyDoc !== undefined) body.bodyDoc = edit.bodyDoc;
  if (view.kind === "new") {
    if (edit.subject !== undefined) body.subject = edit.subject;
    if (edit.to !== undefined) body.to = edit.to.map(addressInput);
    if (edit.cc !== undefined) body.cc = edit.cc.map(addressInput);
    if (edit.bcc !== undefined) body.bcc = edit.bcc.map(addressInput);
  } else if (edit.replyAll !== undefined) {
    body.replyAll = edit.replyAll;
  }
  return { method: "PATCH", path: draftPath(view.id), body };
}

export interface DraftEdit {
  bodyDoc?: EmailDocNode | null;
  subject?: string | null;
  to?: readonly DraftAddress[];
  cc?: readonly DraftAddress[];
  bcc?: readonly DraftAddress[];
  replyAll?: boolean;
}

/** Later edits win field by field: the queue keeps one pending PATCH body. */
export function mergeEdits(a: DraftEdit | undefined, b: DraftEdit): DraftEdit {
  return { ...(a ?? {}), ...b };
}

const addressInput = (a: DraftAddress) => (a.name ? { address: a.address, name: a.name } : { address: a.address });

/** The send (R10): the review hash the server handed back and his ticks. Nothing else. */
export function sendRequest(id: string, review: Pick<ReviewResult, "reviewHash">, acks: readonly ReviewBlocker[]): PanelRequest | null {
  if (review.reviewHash === null) return null;
  return { method: "POST", path: draftPath(id, "/send"), body: { reviewHash: review.reviewHash, acks: [...new Set(acks)] } };
}

// ---------------------------------------------------------------------------
// Creating a draft (R2)
// ---------------------------------------------------------------------------

export type CreateSeed =
  | { kind: "reply"; threadId: string; replyAll: boolean; checkedOutlook: boolean }
  | { kind: "new"; accountId: string | null; to: readonly DraftAddress[]; cc: readonly DraftAddress[]; bcc: readonly DraftAddress[]; subject: string };

export function createRequest(seed: CreateSeed, generate: boolean, instruction: string): PanelRequest {
  const text = instruction.trim();
  const body: Record<string, unknown> =
    seed.kind === "reply"
      ? { kind: "reply", threadId: seed.threadId, generate, replyAll: seed.replyAll }
      : {
          kind: "new",
          generate,
          to: seed.to.map(addressInput),
          ...(seed.cc.length > 0 ? { cc: seed.cc.map(addressInput) } : {}),
          ...(seed.bcc.length > 0 ? { bcc: seed.bcc.map(addressInput) } : {}),
          ...(seed.subject.trim() !== "" ? { subject: seed.subject.trim() } : {}),
          ...(seed.accountId ? { accountId: seed.accountId } : {})
        };
  if (seed.kind === "reply" && seed.checkedOutlook) body.checkedOutlook = true;
  if (text !== "") body.instruction = text;
  return { method: "POST", path: DRAFTS_API, body };
}

export type CreateOutcome =
  | { kind: "created"; href: string }
  | { kind: "hold" }
  | { kind: "sent_copy_found" }
  | { kind: "error"; lines: string[] };

export function createOutcome(status: number, json: unknown): CreateOutcome {
  const o = asObject(json);
  if (status >= 200 && status < 300 && typeof o.id === "string" && o.id !== "") return { kind: "created", href: draftPageHref(o.id) };
  const code = typeof o.error === "string" ? o.error : null;
  if (status === 409 && code === "hold") return { kind: "hold" };
  if (status === 409 && code === "sent_copy_found") return { kind: "sent_copy_found" };
  return { kind: "error", lines: errorLines(status, o) };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface PanelOutcome {
  /** Whether the answer was a 2xx. */
  ok: boolean;
  status: number;
  /** A view the answer carried (show it), else null (re-read with GET when `refetch`). */
  view: DraftView | null;
  refetch: boolean;
  /** The sentences to show above the banner (one fixed sentence per code; a recipient list has one line per entry). */
  lines: string[];
  /** A read-back to show (the Outlook version: a check, or a 409 `changed`). */
  readBack: ReadBackView | null;
  /** A review to open the confirm dialog with. */
  review: ReviewResult | null;
  /** Go to another draft page (a successor draft). */
  navigate: string | null;
  /** The code the answer named, for the panel's own branches. */
  code: string | null;
}

const asObject = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function isView(v: unknown): v is DraftView {
  const o = asObject(v);
  return typeof o.id === "string" && typeof o.status === "string" && typeof o.version === "number" && typeof o.capabilities === "object" && o.capabilities !== null;
}

function isReadBack(v: unknown): v is ReadBackView {
  const o = asObject(v);
  return typeof o.srcdoc === "string" && typeof o.contentHash === "string" && Array.isArray(o.to);
}

function isReview(v: unknown): v is ReviewResult {
  const o = asObject(v);
  return typeof o.status === "string" && Array.isArray(o.blockers) && Array.isArray(o.errors) && "readBack" in o;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The sentences for an error answer `{ error: code, ...extra }`: DD's fixed copy, filled from DD data only. */
export function errorLines(status: number, o: Record<string, unknown>): string[] {
  const code = typeof o.error === "string" ? o.error : null;
  if (code === "recipients_blocked") {
    const clientName = typeof o.clientName === "string" ? o.clientName : null;
    const entries = Array.isArray(o.errors) ? o.errors : [];
    const lines = entries
      .map((e) => asObject(e))
      .filter((e) => typeof e.code === "string")
      .map((e) => recipientEntry(e.code as string, typeof e.address === "string" ? e.address : null, clientName));
    return [ROUTE_CODE_SENTENCE.recipients_blocked, ...lines];
  }
  const sentence = codeSentence(code, {
    reason: typeof o.reason === "string" ? o.reason : null,
    status: typeof o.status === "string" ? o.status : null,
    retryAfterSec: num(o.retryAfterSec),
    constructs: strings(o.constructs),
    fromClone: o.from === "clone"
  });
  if (sentence !== null) return [sentence];
  if (status === 401 || status === 404) return [ROUTE_CODE_SENTENCE.not_found];
  if (status === 403) return [ROUTE_CODE_SENTENCE.forbidden];
  if (status === 429) return [ROUTE_CODE_SENTENCE.rate_limited];
  if (status >= 500) return [ROUTE_CODE_SENTENCE.unavailable];
  return [GENERIC_FAILURE_SENTENCE];
}

const EMPTY: Omit<PanelOutcome, "ok" | "status"> = { view: null, refetch: false, lines: [], readBack: null, review: null, navigate: null, code: null };

/**
 * What an action's answer means for the panel. Every non-2xx answer re-reads
 * the draft (the state may have moved on) and shows its code's sentence; a
 * 2xx shows the view it carried, the read-back, the review or the successor.
 */
export function outcomeOf(action: DraftUiAction | "send" | "outlook_opened" | "edit", status: number, json: unknown): PanelOutcome {
  const o = asObject(json);
  const code = typeof o.code === "string" ? o.code : typeof o.error === "string" ? o.error : null;
  if (status < 200 || status >= 300) {
    return {
      ...EMPTY,
      ok: false,
      status,
      refetch: true,
      lines: errorLines(status, o),
      code,
      // A 409 `changed` on "It wasn't sent" carries the read-back for "Delete it anyway" (T43).
      readBack: isReadBack(o.readBack) ? o.readBack : null
    };
  }
  if (action === "review") {
    if (!isReview(json)) return { ...EMPTY, ok: false, status, refetch: true, lines: [GENERIC_FAILURE_SENTENCE] };
    // T28: the read-back wasn't a live `saved` draft; the row moved, so no dialog.
    if (json.status !== "saved") return { ...EMPTY, ok: true, status, refetch: true, code };
    return { ...EMPTY, ok: true, status, refetch: true, review: json };
  }
  if (isView(json)) return { ...EMPTY, ok: true, status, view: json, code };
  const view = isView(o.view) ? o.view : null;
  const readBack = isReadBack(o.readBack) ? o.readBack : null;
  const lines: string[] = [];
  // ui-5: a code the answer's view records as its lastError is stated by the banner (its notice or headline);
  // saying it here too would show it twice, with two different waits for `throttled`.
  const statedByBanner = view !== null && code !== null && view.lastError?.code === code;
  const quiet = code === null || code === "accepted" || (code === "outcome_unknown" && status === 202) || statedByBanner;
  if (!quiet) {
    // ui-6: a bad_request in a 2xx answer's code can only be the clone's (DD's own is a 400 `error`).
    const s = codeSentence(code, { retryAfterSec: num(o.retryAfterSec), fromClone: true });
    lines.push(s ?? GENERIC_FAILURE_SENTENCE);
  }
  const navigate = typeof o.newDraftId === "string" && o.newDraftId !== "" ? draftPageHref(o.newDraftId) : null;
  return { ...EMPTY, ok: true, status, view, refetch: view === null, lines, readBack, navigate, code };
}

/**
 * P9 F27: where focus goes when an action or a send finishes. A send's dialog closing (sending went false) → the
 * banner's headline; an action ending (busy went false) with focus lost with the pressed button (focus on <body> or
 * nothing) → the headline; anything else → leave it where it is (null). Pure.
 */
export function draftFocusTarget(
  prev: { busy: boolean; sending: boolean },
  next: { busy: boolean; sending: boolean },
  focusWasLost: boolean
): "headline" | null {
  if (prev.sending && !next.sending) return "headline";
  if (prev.busy && !next.busy && focusWasLost) return "headline";
  return null;
}

/** Statuses whose view a successful save, discard or send can leave mid-flight (the panel keeps polling). */
export const IN_FLIGHT: ReadonlySet<ExecDraftStatus> = new Set<ExecDraftStatus>(["generating", "saving", "sending", "discarding", "sent_pending"]);
