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

// Build a global, case-insensitive regex matching a `cid:` reference for one
// content-id. Content-ids routinely contain `@` and `.`, so they're
// regex-escaped. The clone stores content_id without angle brackets, but real
// bodies sometimes wrap them (`cid:<id>`), so tolerate optional `<>`.
export function cidPattern(contentId: string): RegExp {
  const escaped = contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`cid:<?${escaped}>?`, "gi");
}

// Rewrite each inline-image `cid:` reference in `html` to DD's authenticated
// attachment proxy — the same URL shape the download chips already use. Only
// attachments with a content_id are inline images; ordinary files are skipped.
// Returns `html` untouched when there's nothing to rewrite.
export function rewriteInlineCids(
  html: string,
  attachments: MissiveMessageAttachment[],
  accountId: string,
  threadId: string
): string {
  if (!html) return html;
  let out = html;
  for (const a of attachments) {
    if (!a.content_id) continue;
    const url =
      `/api/inboxes/attachments/${encodeURIComponent(a.id)}` +
      `?account=${encodeURIComponent(accountId)}&thread=${encodeURIComponent(threadId)}`;
    out = out.replace(cidPattern(a.content_id), url);
  }
  return out;
}
