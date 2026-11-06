import type { AttentionItem } from "@/lib/exec/attention-types";

// Links into the drafts UI (P4 contract §3.13.3; Area E). Client-safe and
// pure: no imports beyond a type, so a client component and a server
// component build the same hrefs.
//
// The new-draft page accepts a thread id of the shape below and 404s on any
// other (§3.13.2), so a link is only built for ids it will take; an email
// attention item whose fingerprint names another kind of thread id gets no
// link rather than a dead one.

const DRAFT_THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_THREAD_PREFIX = "email:thread:";

/** The thread id of an `email:thread:<threadId>:<anchorMessageId>` fingerprint, when the drafts pages accept it. */
export function draftThreadIdOf(fingerprint: string): string | null {
  if (typeof fingerprint !== "string" || !fingerprint.startsWith(EMAIL_THREAD_PREFIX)) return null;
  const rest = fingerprint.slice(EMAIL_THREAD_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  const threadId = rest.slice(0, cut);
  return DRAFT_THREAD_ID.test(threadId) ? threadId : null;
}

/** "/executive/email/drafts/new?threadId=<id>" for a thread id the new-draft page accepts; else null. */
export function draftReplyHref(threadId: string): string | null {
  if (typeof threadId !== "string" || !DRAFT_THREAD_ID.test(threadId)) return null;
  return `/executive/email/drafts/new?threadId=${encodeURIComponent(threadId)}`;
}

/** "/executive/email/drafts/new?threadId=<id>" for a source-email item whose fingerprint is email:thread:<id>:…; else null. */
export function draftReplyHrefFor(item: Pick<AttentionItem, "source" | "fingerprint">): string | null {
  if (!item || item.source !== "email") return null;
  const threadId = draftThreadIdOf(item.fingerprint);
  return threadId === null ? null : draftReplyHref(threadId);
}

export function draftPageHref(id: string): string {
  return `/executive/email/drafts/${encodeURIComponent(id)}`;
}

/** The "New email" page. */
export const NEW_EMAIL_HREF = "/executive/email/drafts/new";
/** The Email tab's Drafts view. */
export const DRAFTS_BUCKET_HREF = "/executive/email?bucket=drafts";
