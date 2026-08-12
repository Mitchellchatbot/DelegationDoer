// How an email attachment should be previewed/rendered, derived from its
// content-type and filename.
//
// Lifted out of AttachmentChip so the print/save pipeline classifies files the
// exact same way the thread UI does — one file family should never render as a
// PDF page in the reading pane and a bare download link in the printout. Kept
// dependency-free (no React, no lucide) so both a client component and the
// document builder can import it.

import type { MissiveMessageAttachment } from "@/lib/missive-client";

export type PreviewKind = "image" | "pdf" | "doc";

export const PDF_RE = /\.pdf$/i;
export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const DOC_RE = /\.(docx|xlsx|xlsm|xlsb|xls|csv|tsv|txt|log|md|json|xml|yml|yaml)$/i;

export function bareType(contentType: string | null | undefined): string {
  return (contentType || "").toLowerCase().split(";")[0].trim();
}

// What kind of preview (if any) this file supports. SVG is excluded from image
// preview (inline SVG is an XSS vector). Kept in sync with the server's
// canRenderDoc so we only offer previews the route can actually serve.
export function previewKind(a: MissiveMessageAttachment): PreviewKind | null {
  const ct = bareType(a.content_type);
  if (ct === "application/pdf" || PDF_RE.test(a.filename)) return "pdf";
  if ((ct.startsWith("image/") && ct !== "image/svg+xml") || IMAGE_RE.test(a.filename)) return "image";
  if (
    DOC_RE.test(a.filename) ||
    ct.includes("wordprocessingml") ||
    ct.includes("spreadsheetml") ||
    ct === "application/vnd.ms-excel" ||
    ct === "text/csv" ||
    ct.startsWith("text/")
  ) return "doc";
  return null;
}

// Canonical, allowlist-safe mime handed to the proxy so it can serve inline
// even when the clone typed the file as octet-stream.
export function previewMime(a: MissiveMessageAttachment, kind: PreviewKind): string {
  if (kind === "pdf") return "application/pdf";
  const ct = bareType(a.content_type);
  if (ct.startsWith("image/") && ct !== "image/svg+xml") return ct;
  const m = a.filename.toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp)$/);
  if (!m) return "";
  return m[1] === "jpg" || m[1] === "jpeg" ? "image/jpeg" : `image/${m[1]}`;
}

// The access-checked proxy that streams an attachment's bytes. Every consumer
// (chips, inline cid rewrites, previews, print) goes through this one builder so
// the query contract stays in a single place.
export function attachmentProxyUrl(
  attachmentId: string,
  accountId: string,
  threadId: string
): string {
  return (
    `/api/inboxes/attachments/${encodeURIComponent(attachmentId)}` +
    `?account=${encodeURIComponent(accountId)}&thread=${encodeURIComponent(threadId)}`
  );
}

// The proxy URL that renders this attachment for VIEWING: documents come back
// as converted HTML, pdf/images inline (the route only serves those inline, and
// only for its own allowlist). Non-previewable types fall back to the plain
// download URL.
export function attachmentContentUrl(
  a: MissiveMessageAttachment,
  accountId: string,
  threadId: string
): string {
  const base = attachmentProxyUrl(a.id, accountId, threadId);
  const kind = previewKind(a);
  if (kind === "doc") return `${base}&render=html`;
  if (kind) return `${base}&inline=1&mime=${encodeURIComponent(previewMime(a, kind))}`;
  return base;
}

// The MIME type to stamp on a `data:` URI or an .eml part for this file. Falls
// back to the attachment's own content_type, then to octet-stream — never
// empty, which would make a data: URI unparseable.
export function effectiveMime(a: MissiveMessageAttachment): string {
  const kind = previewKind(a);
  const preview = kind ? previewMime(a, kind) : "";
  return preview || bareType(a.content_type) || "application/octet-stream";
}
