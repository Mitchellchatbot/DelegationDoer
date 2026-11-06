import "server-only";

import { looksRoleAddress } from "@/lib/email-intake-filters";
import type { CloneAddress, CloneReadBack } from "@/lib/exec/clone-ea-types";
import type { DraftAddress, ReadBackView, RecipientBadge, RecipientView } from "@/lib/exec/drafts-types";
import { buildEmailSrcdoc } from "@/lib/exec/email-srcdoc";
import { sanitizeText } from "@/lib/exec/triage/email-text";

// The read-back adapters (P4 contract §3.13.1, C64, C66, C75): how the clone's
// read-back of an Outlook draft becomes what the confirm dialog shows.
//
// readBackSrcdoc runs P3's email-srcdoc builder with remote images OFF (C47) and
// puts P4's own Content-Security-Policy meta FIRST in <head>, before P3's: the
// browser intersects the two, so the read-back document can run nothing, load
// nothing (not even an image he clicked to show; there is no such button here),
// connect nowhere, frame nothing and submit nothing. P3's locks stay: its CSP,
// the inert renames, the URL-attribute removal, on* stripping, cid
// placeholders, the no-referrer meta. If P3's builder ever stops producing the
// head opening this code expects, the adapter throws rather than hand out a
// document whose first element isn't P4's CSP: the dialog then shows no
// preview and no Send button (C64).
//
// The frame that shows the result is components/exec/drafts/ReadBackFrame.tsx:
// sandbox="" (opaque origin, no scripts, no popups), so even a document that
// slipped past both CSPs could not carry DD's cookies anywhere.
//
// Pure given its inputs; nothing here logs (the read-back is his draft).

/** P4's read-back CSP (C64). Inserted as the FIRST element of <head>, before P3's own CSP meta; CSPs intersect. */
export const READ_BACK_CSP = "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; "
  + "media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const HEAD_OPENING = "<!DOCTYPE html><html><head>";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The exact meta element the read-back document starts its <head> with. */
export const READ_BACK_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(READ_BACK_CSP)}">`;

/**
 * P3's email-srcdoc builder with images OFF (C47), then P4's CSP meta inserted
 * directly after the bound <head> opening (bindings AM1); throws when the output
 * doesn't start with it (the dialog then refuses to render, C64). Returns the
 * srcdoc, the remote images not loaded, and P3's truncated flag.
 */
export function readBackSrcdoc(html: string): { srcdoc: string; remoteImageCount: number; truncated: boolean } {
  const built = buildEmailSrcdoc(html, { showRemoteImages: false });
  if (typeof built.srcdoc !== "string" || !built.srcdoc.startsWith(HEAD_OPENING)) {
    throw new Error("readBackSrcdoc: the email-srcdoc builder's document does not open as expected");
  }
  const srcdoc = HEAD_OPENING + READ_BACK_CSP_META + built.srcdoc.slice(HEAD_OPENING.length);
  if (!srcdoc.startsWith(HEAD_OPENING + READ_BACK_CSP_META)) {
    throw new Error("readBackSrcdoc: the read-back document does not start with P4's CSP");
  }
  return { srcdoc, remoteImageCount: built.remoteImages, truncated: built.truncated };
}

// --- addresses -------------------------------------------------------------------------

const NAME_MAX = 256;

/** An address as DD stores it: trimmed and lowercased; null when empty. */
function addressOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim().toLowerCase();
  return a.length > 0 ? a : null;
}

/** A display name as DD shows it: sanitized, one line, ≤256 characters; null when empty. Untrusted data (C75). */
function nameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = sanitizeText(raw).replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return n.length > 0 ? n : null;
}

function draftAddress(a: CloneAddress | null | undefined): DraftAddress | null {
  if (!a) return null;
  const address = addressOf(a.address);
  return address === null ? null : { address, name: nameOf(a.name) };
}

function draftAddresses(list: readonly CloneAddress[] | null | undefined): DraftAddress[] {
  const out: DraftAddress[] = [];
  for (const a of Array.isArray(list) ? list : []) {
    const d = draftAddress(a);
    if (d) out.push(d);
  }
  return out;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1);
}

const lowerSet = (list: readonly DraftAddress[] | undefined): ReadonlySet<string> =>
  new Set((list ?? []).map((a) => a.address.trim().toLowerCase()).filter((a) => a.length > 0));

export interface ReadBackViewContext {
  /** listInternalAddresses().domains, lowercased: recipients elsewhere get the `external` badge. */
  internalDomains: ReadonlySet<string>;
  /** DD's stored To list: a read-back recipient outside the stored lists is `added_in_outlook`. */
  storedTo: readonly DraftAddress[];
  /** DD's stored Cc / Bcc lists (additive; without them only storedTo counts as stored). */
  storedCc?: readonly DraftAddress[];
  storedBcc?: readonly DraftAddress[];
  /** The thread's addresses, lowercased (reply drafts); when given, a recipient outside it is `not_in_thread`. */
  threadAddresses?: ReadonlySet<string>;
}

/**
 * contentHash is the read-back's own (ReadBackView.contentHash, C66); names stay
 * data (C75). Badges: `external` (domain not internal), `role` (looksRoleAddress),
 * `added_in_outlook` (not in DD's stored lists), `not_in_thread` (only when
 * ctx.threadAddresses is given). Throws when readBackSrcdoc refuses (C64).
 */
export function toReadBackView(rb: CloneReadBack, ctx: ReadBackViewContext): ReadBackView {
  const stored = new Set<string>([...lowerSet(ctx.storedTo), ...lowerSet(ctx.storedCc), ...lowerSet(ctx.storedBcc)]);
  const badge = (a: DraftAddress): RecipientView => {
    const badges: RecipientBadge[] = [];
    const domain = domainOf(a.address);
    if (domain === "" || !ctx.internalDomains.has(domain)) badges.push("external");
    if (looksRoleAddress(a.address).filtered) badges.push("role");
    if (ctx.threadAddresses !== undefined && !ctx.threadAddresses.has(a.address)) badges.push("not_in_thread");
    if (!stored.has(a.address)) badges.push("added_in_outlook");
    return { address: a.address, name: a.name, badges };
  };
  const body = readBackSrcdoc(typeof rb.bodyHtml === "string" ? rb.bodyHtml : "");
  const flags = Array.isArray(rb.flags) ? rb.flags : [];
  return {
    from: draftAddress(rb.from),
    sender: draftAddress(rb.sender),
    replyTo: draftAddresses(rb.replyTo),
    to: draftAddresses(rb.to).map(badge),
    cc: draftAddresses(rb.cc).map(badge),
    bcc: draftAddresses(rb.bcc).map(badge),
    subject: typeof rb.subject === "string" ? sanitizeText(rb.subject).replace(/\s+/g, " ").trim() : "",
    srcdoc: body.srcdoc,
    remoteImageCount: body.remoteImageCount,
    truncated: body.truncated,
    attachments: (Array.isArray(rb.attachments) ? rb.attachments : []).map((a) => ({
      name: nameOf(a.name) ?? "attachment",
      size: typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? a.size : 0,
      isInline: a.isInline === true,
      contentType: typeof a.contentType === "string" && a.contentType.length > 0 ? a.contentType.slice(0, 200) : null
    })),
    signatureSkipped: flags.includes("signature_skipped"),
    contentHash: rb.contentHash
  };
}
