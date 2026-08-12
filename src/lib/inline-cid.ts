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
import { attachmentProxyUrl } from "@/lib/attachment-kind";

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
// shown twice. A content_id attachment that no `cid:` references (rare, but
// possible) is deliberately NOT included, so it still gets a chip and can never
// silently vanish.
export function referencedInlineIds(
  html: string,
  attachments: MissiveMessageAttachment[]
): Set<string> {
  const ids = new Set<string>();
  if (!html) return ids;
  for (const a of attachments) {
    if (a.content_id && cidPattern(a.content_id).test(html)) ids.add(a.id);
  }
  return ids;
}
