// Helpers for inline-image (`cid:<content-id>`) references in email HTML.
//
// Emails embed images by referencing them from the HTML body as
// `<img src="cid:<content-id>">`, with the bytes carried as a separate MIME
// part whose Content-ID matches. Two places in DD need to resolve those
// references because the raw `cid:` URL scheme resolves nowhere in a browser:
//   - the thread view renders the body in a sandboxed iframe (EmailBody) that
//     can't fetch `cid:` URLs, so received inline images show broken; and
//   - forwarding inlines the original body verbatim, so its `cid:` refs would
//     dangle once the message is re-sent.
// Both reuse cidPattern() so the matching logic stays in one place.

import type { MissiveMessageAttachment } from "@/lib/missive-client";
import { attachmentProxyUrl, bareType, IMAGE_RE } from "@/lib/attachment-kind";

// Build a global, case-insensitive regex matching a `cid:` reference for one
// content-id. Content-ids routinely contain `@` and `.`, so they're
// regex-escaped. The clone stores content_id without angle brackets, but real
// bodies sometimes wrap them (`cid:<id>`), so tolerate optional `<>`.
export function cidPattern(contentId: string): RegExp {
  const escaped = contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`cid:<?${escaped}>?`, "gi");
}

// Rewrite each inline-image `cid:` reference in `html` to whatever `resolve`
// returns for that attachment. Only attachments with a content_id are inline
// images; ordinary files are skipped, as is any attachment `resolve` declines
// (returns null for) — its `cid:` is left alone rather than replaced with a
// broken URL. Returns `html` untouched when there's nothing to rewrite.
//
// The resolver exists because the two consumers need different targets: the
// thread view points at the authenticated proxy (same-origin, cookies flow),
// while the print/save document needs a self-contained `data:` URI that still
// works in a downloaded file opened from disk.
export function rewriteInlineCidsWith(
  html: string,
  attachments: MissiveMessageAttachment[],
  resolve: (a: MissiveMessageAttachment) => string | null
): string {
  if (!html) return html;
  let out = html;
  for (const a of attachments) {
    if (!a.content_id) continue;
    const url = resolve(a);
    if (!url) continue;
    out = out.replace(cidPattern(a.content_id), url);
  }
  return out;
}

// Rewrite inline `cid:` refs to DD's authenticated attachment proxy — the same
// URL shape the download chips already use. The thread-view default.
export function rewriteInlineCids(
  html: string,
  attachments: MissiveMessageAttachment[],
  accountId: string,
  threadId: string
): string {
  return rewriteInlineCidsWith(html, attachments, (a) =>
    attachmentProxyUrl(a.id, accountId, threadId)
  );
}

// The subset of `attachments` that are inline images ACTUALLY referenced by a
// `cid:` in `html` — i.e. the ones rewriteInlineCids just rendered into the
// body. Callers hide these from the download-chip row so an inline image isn't
// shown twice. A content_id attachment that no `cid:` references (common: the
// clone stores a Content-ID on nearly every part, Outlook PDFs/.ics included)
// is deliberately NOT included, so it still gets a chip and can never silently
// vanish.
//
// Only images count — by content type, or by filename when the clone typed the
// part application/octet-stream (the same test previewKind uses). A referenced
// PDF or .ics can't render in an <img>, so treating it as inline would leave it
// reachable only as a broken-image box; it keeps its chip (and print lists it
// as a file). The .eml export still keeps such a part's Content-ID, so the
// body's cid: reference resolves there regardless.
export function referencedInlineIds(
  html: string,
  attachments: MissiveMessageAttachment[]
): Set<string> {
  const ids = new Set<string>();
  if (!html) return ids;
  for (const a of attachments) {
    if (!a.content_id) continue;
    if (!bareType(a.content_type).startsWith("image/") && !IMAGE_RE.test(a.filename)) continue;
    if (cidPattern(a.content_id).test(html)) ids.add(a.id);
  }
  return ids;
}

// The attachments that deserve a download chip (and the collapsed-stub
// paperclip) for one message, given its body html.
//
// "Inline" means the message's OWN body references `cid:<content_id>` (see
// referencedInlineIds) — `content_id != null` alone is NOT an inline signal,
// because Outlook stamps a Content-ID on ordinary PDFs and invites too.
//
//   - html known: drop the inline images the body renders (including ones that
//     sit only inside quoted history, reachable under the "•••" toggle).
//   - html null (text-only body, or its load failed): every attachment chips,
//     so a real file can never disappear.
//   - `pending` (deferred body not loaded yet): hide anything with a
//     content_id until the body decides, so inline images never flash up as
//     chips; attachments with no content_id can't be cid-referenced, so their
//     chip is already final and shows immediately. Net: a chip, once shown, is
//     never taken away.
//
// Also collapses identical rows within the message (same content_id +
// size_bytes = the same MIME part stored twice by the clone's ingest race).
// Rows without a content_id are never merged — two same-size files are real.
export function chipAttachments(
  attachments: MissiveMessageAttachment[],
  html: string | null,
  { pending = false }: { pending?: boolean } = {}
): MissiveMessageAttachment[] {
  const inline = !pending && html ? referencedInlineIds(html, attachments) : null;
  const seen = new Set<string>();
  return attachments.filter((a) => {
    if (pending && a.content_id) return false;
    if (inline?.has(a.id)) return false;
    if (a.content_id) {
      const key = `${a.content_id}|${a.size_bytes}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}
