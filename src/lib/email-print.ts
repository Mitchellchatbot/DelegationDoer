"use client";

// Build a clean, self-contained printable document for one email or a whole
// thread, then either open the browser print dialog (Save-as-PDF from there) or
// download it as a standalone .html file. Mirrors how the app renders a message
// (the sandboxed EmailBody iframe): same baseline typography, the email's own
// HTML kept intact, quoted history left fully expanded (a printed copy should be
// complete, not folded).
//
// Deferred bodies (older messages whose body_html was withheld on thread open)
// are resolved through the same client cache the reading pane uses, fetching any
// that haven't been warmed yet — so printing a thread never prints blank cards.
//
// ATTACHMENTS ARE PART OF THE DOCUMENT. A printed email that silently drops the
// six PDFs it was carrying isn't a copy of that email. Every attachment is
// downloaded through the access-checked proxy and embedded as a `data:` URI:
//   - inline (cid:) images  → rewritten into the body, so they actually render
//   - image attachments     → shown full-width in their own section
//   - PDFs                  → rasterized page-by-page (browsers won't print an
//                             embedded PDF) so the pages land in the printout
//   - docx/xlsx/csv/txt     → rendered via the server's existing ?render=html
//   - anything else         → listed in the manifest with a download link
// `data:` (rather than proxy URLs) is what makes a saved .html still work when
// it's opened from disk later, with no session and no network.

import type { MissiveMessage, MissiveMessageAttachment } from "@/lib/missive-client";
import { getCachedBody, fetchDeferredBody } from "@/lib/message-body-cache";
import { loadAttachments, dataUri, bufferToBase64 } from "@/lib/attachment-bytes";
import { previewKind, effectiveMime, attachmentContentUrl } from "@/lib/attachment-kind";
import { rewriteInlineCidsWith, referencedInlineIds } from "@/lib/inline-cid";
import { rasterizePdf } from "@/lib/pdf-raster";
import { formatBytes } from "@/lib/email-format";

export interface EmailPrintContext {
  accountId: string;
  threadId: string;
  // Falls back to the first message's subject when omitted.
  threadSubject?: string;
}

// What a print/save run left out. Surfaced to the user — a printout that quietly
// dropped an attachment reads as complete when it isn't.
export interface PrintOutcome {
  skipped: { filename: string; reason: string }[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Slugify a subject into a safe file base name.
function safeFileBase(subject: string): string {
  const base = (subject || "email")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "email";
}

// The server's ?render=html conversion returns a COMPLETE html document — its
// own <head>, and its own <style> setting `body`, `table`, `td`, `pre`… A
// <style> applies to the whole document no matter how deeply it's nested, so
// dropping that markup into a <div> lets one attached .docx silently restyle the
// email body and every other attachment on the page. Take the <body> contents
// and leave the styling to .dd-att-doc.
function documentBodyOnly(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const inner = body ? body[1] : html;
  // Belt and braces: strip any <style>/<script> that lived outside <body> is
  // already handled by taking the body, but converted documents occasionally
  // inline a <style> within it too.
  return inner
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
}

function bodyHtmlOf(m: MissiveMessage): string | null {
  return m.body_html ?? getCachedBody(m.id)?.body_html ?? null;
}

function bodyTextOf(m: MissiveMessage): string | null {
  return m.body_text ?? getCachedBody(m.id)?.body_text ?? null;
}

// Ensure every message we're about to print has a body available, fetching any
// deferred ones still missing from the cache. Errors are swallowed per-message
// (that card falls back to whatever text it has) so one failure can't abort the
// whole print.
async function ensureBodies(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<void> {
  await Promise.all(
    messages.map(async (m) => {
      const hasBody =
        m.body_html || m.body_text || getCachedBody(m.id) !== undefined;
      if (hasBody || !m.body_deferred) return;
      try {
        await fetchDeferredBody(m.id, ctx.accountId, ctx.threadId);
      } catch {
        /* fall back to whatever text the message carries */
      }
    })
  );
}

// --- attachment preparation --------------------------------------------------

// How one attachment will appear in the document. `href` is always the original
// file as a data: URI (so the manifest's download link works offline); the extra
// fields carry the rendered representation when we have one.
interface PreparedAttachment {
  att: MissiveMessageAttachment;
  href: string | null;
  // Set when this attachment is an inline image the body references — it gets
  // rewritten into the body and no separate section.
  inline: boolean;
  image?: string;
  pdfPages?: string[];
  pdfTotalPages?: number;
  docHtml?: string;
  // Why we couldn't render it (still listed in the manifest).
  note?: string;
}

type PreparedByMessage = Map<string, PreparedAttachment[]>;

async function prepareAttachments(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<{ prepared: PreparedByMessage; skipped: PrintOutcome["skipped"] }> {
  const all = messages.flatMap((m) => m.attachments ?? []);
  const prepared: PreparedByMessage = new Map();
  const skipped: PrintOutcome["skipped"] = [];
  if (all.length === 0) return { prepared, skipped };

  const { bytes, skipped: fetchSkipped } = await loadAttachments(
    all,
    ctx.accountId,
    ctx.threadId
  );
  for (const s of fetchSkipped) {
    skipped.push({
      filename: s.filename,
      reason: s.reason === "too-large" ? "too large to embed" : "couldn't be downloaded"
    });
  }

  for (const m of messages) {
    const atts = m.attachments ?? [];
    if (atts.length === 0) continue;
    const html = bodyHtmlOf(m);
    const inlineIds = html ? referencedInlineIds(html, atts) : new Set<string>();

    const items = await Promise.all(
      atts.map(async (att): Promise<PreparedAttachment> => {
        const buf = bytes.get(att.id);
        const inline = inlineIds.has(att.id);
        if (!buf) {
          // Already recorded in `skipped` above. Force it into the manifest
          // even when it's an inline image: its cid: can't be rewritten, so the
          // body will show a broken-image box, and an unexplained broken box is
          // worse than a listed "not included" line.
          return { att, href: null, inline: false, note: "not included" };
        }
        const href = dataUri(att, buf);
        if (inline) return { att, href, inline: true };

        const kind = previewKind(att);
        if (kind === "image") return { att, href, inline: false, image: href };
        if (kind === "pdf") {
          try {
            const { pages, totalPages } = await rasterizePdf(buf);
            return {
              att, href, inline: false, pdfPages: pages, pdfTotalPages: totalPages,
              note: totalPages > pages.length
                ? `showing first ${pages.length} of ${totalPages} pages`
                : undefined
            };
          } catch {
            skipped.push({ filename: att.filename, reason: "couldn't be rendered" });
            return { att, href, inline: false, note: "preview unavailable" };
          }
        }
        if (kind === "doc") {
          try {
            const res = await fetch(attachmentContentUrl(att, ctx.accountId, ctx.threadId));
            if (!res.ok) throw new Error(String(res.status));
            return { att, href, inline: false, docHtml: documentBodyOnly(await res.text()) };
          } catch {
            skipped.push({ filename: att.filename, reason: "couldn't be rendered" });
            return { att, href, inline: false, note: "preview unavailable" };
          }
        }
        return { att, href, inline: false };
      })
    );
    prepared.set(m.id, items);
  }

  return { prepared, skipped };
}

const DOC_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; color: #101828; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .dd-doc { max-width: 800px; margin: 0 auto; padding: 24px 28px 40px; }
  .dd-thread-subject {
    font-size: 20px; font-weight: 600; margin: 0 0 20px;
    padding-bottom: 12px; border-bottom: 2px solid #e5e7eb;
  }
  .dd-msg { margin: 0 0 28px; }
  .dd-msg + .dd-msg { padding-top: 24px; border-top: 1px solid #e5e7eb; }
  .dd-hdr { margin: 0 0 12px; }
  .dd-hdr .dd-from { font-weight: 600; font-size: 15px; }
  .dd-hdr .dd-meta {
    margin-top: 2px; font-size: 12px; color: #475467;
    display: grid; grid-template-columns: max-content 1fr; gap: 1px 8px;
  }
  .dd-hdr .dd-meta .dd-label { color: #98a2b3; }
  .dd-body { word-wrap: break-word; overflow-wrap: anywhere; }
  .dd-body img { max-width: 100%; height: auto; }
  .dd-body table { max-width: 100%; }
  .dd-body a { color: #063270; }
  .dd-body blockquote {
    border-left: 3px solid #e5e7eb; margin: 8px 0; padding: 4px 0 4px 12px;
    color: #475467;
  }
  .dd-body pre, .dd-body code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    background: #f3f4f6; border-radius: 4px;
  }
  .dd-body pre { padding: 8px; overflow-x: auto; }
  .dd-body code { padding: 1px 4px; }
  .dd-body-text {
    white-space: pre-wrap; font-family: inherit; font-size: 14px;
    line-height: 1.55; margin: 0;
  }
  .dd-atts { margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 10px; }
  .dd-atts h2 {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .04em; color: #667085; margin: 0 0 6px;
  }
  .dd-att-row { font-size: 12px; color: #344054; padding: 2px 0; }
  .dd-att-row .dd-att-size { color: #98a2b3; }
  .dd-att-row .dd-att-note { color: #b42318; }
  .dd-att-row a { color: #063270; text-decoration: none; }
  .dd-att-sec { margin-top: 22px; padding-top: 14px; border-top: 1px dashed #d0d5dd; }
  .dd-att-sec h3 {
    font-size: 13px; font-weight: 600; margin: 0 0 10px; color: #101828;
  }
  .dd-att-sec h3 .dd-att-size { font-weight: 400; color: #98a2b3; }
  .dd-att-page { display: block; width: 100%; height: auto; margin: 0 0 10px; }
  .dd-att-img { display: block; max-width: 100%; height: auto; }
  .dd-att-doc {
    font-size: 13px; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px;
    overflow-wrap: anywhere;
  }
  .dd-att-doc table { border-collapse: collapse; max-width: 100%; }
  .dd-att-doc td, .dd-att-doc th { border: 1px solid #e5e7eb; padding: 3px 6px; }
  @media print {
    .dd-doc { max-width: none; padding: 0; }
    .dd-msg { page-break-inside: avoid; }
    /* Each attached document starts its own page, the way a printed packet
       separates the cover letter from its enclosures. */
    .dd-att-sec { page-break-before: always; page-break-inside: auto; }
    .dd-att-page, .dd-att-img { page-break-inside: avoid; }
  }
`;

// The email's own HTML if we have it (inline or cached), else the plaintext
// wrapped so it keeps its line breaks. Inline `cid:` images are rewritten to
// data: URIs so they render both in the print dialog and in a saved file.
function messageBodyFragment(m: MissiveMessage, items: PreparedAttachment[]): string {
  const html = bodyHtmlOf(m);
  if (html) {
    const byId = new Map(items.map((i) => [i.att.id, i]));
    const resolved = rewriteInlineCidsWith(
      html,
      m.attachments ?? [],
      (a) => byId.get(a.id)?.href ?? null
    );
    return `<div class="dd-body">${resolved}</div>`;
  }
  const text = bodyTextOf(m);
  return `<pre class="dd-body-text">${escapeHtml(text || "(empty)")}</pre>`;
}

// The "Attachments (N)" manifest — every file the email carried, including ones
// we couldn't render.
//
// `withDownloadLinks` is false for the print path, on purpose. The link's href
// is the file's ENTIRE base64, so emitting it doubles that attachment's cost in
// the document — and on paper a download link is worthless, while inside the
// print iframe's sandbox (no allow-downloads) it wouldn't even fire. It earns
// its place only in the saved .html, where it's how you get the file back out.
function attachmentManifest(
  items: PreparedAttachment[],
  withDownloadLinks: boolean
): string {
  const listed = items.filter((i) => !i.inline);
  if (listed.length === 0) return "";
  const rows = listed.map((i) => {
    const size = i.att.size_bytes > 0 ? formatBytes(i.att.size_bytes) : "";
    const name = escapeHtml(i.att.filename);
    const label = withDownloadLinks && i.href
      ? `<a href="${i.href}" download="${name}">${name}</a>`
      : name;
    return (
      `<div class="dd-att-row">${label}` +
      (size ? ` <span class="dd-att-size">${escapeHtml(size)}</span>` : "") +
      (i.note ? ` <span class="dd-att-note">— ${escapeHtml(i.note)}</span>` : "") +
      `</div>`
    );
  });
  return `<section class="dd-atts">
    <h2>Attachments (${listed.length})</h2>
    ${rows.join("")}
  </section>`;
}

// The rendered contents of each attachment, appended after the message body.
function attachmentSections(items: PreparedAttachment[]): string {
  const out: string[] = [];
  for (const i of items) {
    if (i.inline) continue;
    let inner = "";
    if (i.image) {
      inner = `<img class="dd-att-img" src="${i.image}" alt="${escapeHtml(i.att.filename)}" />`;
    } else if (i.pdfPages?.length) {
      inner = i.pdfPages
        .map((p, n) => `<img class="dd-att-page" src="${p}" alt="Page ${n + 1}" />`)
        .join("");
    } else if (i.docHtml) {
      inner = `<div class="dd-att-doc">${i.docHtml}</div>`;
    } else {
      continue; // nothing renderable — the manifest row already covers it
    }
    const size = i.att.size_bytes > 0 ? formatBytes(i.att.size_bytes) : "";
    out.push(`<section class="dd-att-sec">
      <h3>${escapeHtml(i.att.filename)}${size ? ` <span class="dd-att-size">${escapeHtml(size)}</span>` : ""}</h3>
      ${inner}
    </section>`);
  }
  return out.join("\n");
}

function messageBlock(
  m: MissiveMessage,
  showSubject: boolean,
  items: PreparedAttachment[],
  withDownloadLinks: boolean
): string {
  const rows: string[] = [];
  const to = m.to_addrs?.filter(Boolean) ?? [];
  const cc = m.cc_addrs?.filter(Boolean) ?? [];
  if (showSubject && m.subject) {
    rows.push(
      `<div class="dd-label">Subject</div><div>${escapeHtml(m.subject)}</div>`
    );
  }
  if (to.length) {
    rows.push(
      `<div class="dd-label">To</div><div>${escapeHtml(to.join(", "))}</div>`
    );
  }
  if (cc.length) {
    rows.push(
      `<div class="dd-label">Cc</div><div>${escapeHtml(cc.join(", "))}</div>`
    );
  }
  rows.push(
    `<div class="dd-label">Date</div><div>${escapeHtml(fmtDate(m.sent_at))}</div>`
  );

  return `<article class="dd-msg">
    <header class="dd-hdr">
      <div class="dd-from">${escapeHtml(m.from_addr)}</div>
      <div class="dd-meta">${rows.join("")}</div>
    </header>
    ${messageBodyFragment(m, items)}
    ${attachmentManifest(items, withDownloadLinks)}
    ${attachmentSections(items)}
  </article>`;
}

// Assemble the full standalone HTML document. When more than one message is
// printed we show the shared subject once as a heading and omit the per-message
// Subject row (unless a message's own subject differs).
function buildDocument(
  messages: MissiveMessage[],
  ctx: EmailPrintContext,
  prepared: PreparedByMessage,
  withDownloadLinks: boolean
): string {
  const threadSubject =
    ctx.threadSubject || messages[0]?.subject || "(no subject)";
  const multi = messages.length > 1;
  const heading = multi
    ? `<h1 class="dd-thread-subject">${escapeHtml(threadSubject)}</h1>`
    : "";
  const blocks = messages
    .map((m) =>
      messageBlock(
        m,
        !multi || (m.subject || "") !== threadSubject,
        prepared.get(m.id) ?? [],
        withDownloadLinks
      )
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base target="_blank" />
  <title>${escapeHtml(threadSubject)}</title>
  <style>${DOC_CSS}</style>
</head>
<body>
  <div class="dd-doc">
    ${heading}
    ${blocks}
  </div>
</body>
</html>`;
}

// Open the browser print dialog for the given message(s). Renders the document
// in an off-screen iframe (no popup blocker, unlike window.open) and prints it,
// then cleans the iframe up after the dialog closes.
export async function printEmails(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<PrintOutcome> {
  if (!messages.length) return { skipped: [] };
  await ensureBodies(messages, ctx);
  const { prepared, skipped } = await prepareAttachments(messages, ctx);
  // No download links in the print document: see attachmentManifest.
  const doc = buildDocument(messages, ctx, prepared, false);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  // Same sandbox posture as EmailBody: same-origin so we can drive print() from
  // here, but NO allow-scripts — the document embeds email-authored HTML and
  // server-converted document HTML, neither of which should ever execute.
  // allow-modals is what permits the print dialog itself.
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.srcdoc = doc;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Delay removal so the print dialog (which reads from the iframe) isn't
    // pulled out from under it in browsers that print asynchronously.
    setTimeout(() => iframe.remove(), 1000);
  };

  // Resolves once the dialog has been asked for, so the caller's "some
  // attachments were left out" toast lands alongside the dialog rather than
  // while the user is still looking at an unchanged page.
  const printed = new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        resolve();
        return;
      }
      win.addEventListener("afterprint", cleanup);
      void documentReady(win).then(() => {
        try {
          win.focus();
          win.print();
        } catch {
          /* ignore — user can still download */
        }
        // Fallback cleanup in case afterprint never fires (e.g. dialog cancelled).
        setTimeout(cleanup, 60_000);
        resolve();
      });
    });
  });

  document.body.appendChild(iframe);
  await printed;
  return { skipped };
}

// Resolve when the print document is actually ready to be laid out.
//
// This runs from the iframe's `load` handler, and the document load event
// already blocks on every <img> — so waiting on images here would be a no-op
// dressed up as a safeguard. What load does NOT wait for is fonts: an email's
// own @font-face is still loading at this point, and printing immediately
// renders it in the fallback face. `document.fonts.ready` covers that, and a
// short settle frame after it lets the resulting reflow finish.
//
// Everything is capped, because a print that never opens is worse than one that
// opens slightly early.
function documentReady(win: Window): Promise<void> {
  const fonts = (win.document as Document & { fonts?: FontFaceSet }).fonts;
  const ready: Promise<unknown> = fonts?.ready ?? Promise.resolve();

  const settle = ready.then(
    () =>
      new Promise<void>((resolve) => {
        // Two frames: one for the font swap to apply, one for the reflow.
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
      })
  );

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // Cleared by finish(), so a fast print doesn't leave a stray timer alive.
    const timer = setTimeout(finish, 5_000);
    void settle.then(finish, finish);
  });
}

// Download the given message(s) as a self-contained .html file.
export async function downloadEmails(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<PrintOutcome> {
  if (!messages.length) return { skipped: [] };
  await ensureBodies(messages, ctx);
  const { prepared, skipped } = await prepareAttachments(messages, ctx);
  // Download links DO earn their place here — this file is how you get the
  // attachments back out, and it has to work offline from disk.
  const doc = buildDocument(messages, ctx, prepared, true);
  const subject = ctx.threadSubject || messages[0]?.subject || "email";

  triggerDownload(
    new Blob([doc], { type: "text/html;charset=utf-8" }),
    `${safeFileBase(subject)}.html`
  );
  return { skipped };
}

// Download a single message as an RFC-5322 .eml file — the standard email
// interchange format, so the saved message re-opens in Outlook / Apple Mail /
// Thunderbird with its headers, body and attachments intact (what "download
// message" does in a real mail client). Single-message only: .eml has no concept
// of a thread.
export async function downloadEml(
  message: MissiveMessage,
  ctx: EmailPrintContext
): Promise<PrintOutcome> {
  await ensureBodies([message], ctx);
  const { bytes, skipped } = await loadAttachmentBytesFor([message], ctx);
  const eml = buildEml(message, bytes);
  triggerDownload(
    // message/rfc822 is the correct type; the .eml extension is what desktop
    // mail clients register a file association against.
    new Blob([eml], { type: "message/rfc822" }),
    `${safeFileBase(message.subject || ctx.threadSubject || "email")}.eml`
  );
  return { skipped };
}

// Download a whole thread as a single .eml. An .eml holds one message, so a
// conversation is packed as multipart/digest — the RFC-2046 container for "a
// collection of messages", each an embedded message/rfc822 part built by the
// same per-message assembler. Opens in Outlook / Apple Mail / Thunderbird as one
// item carrying every message in the thread.
export async function downloadThreadEml(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<PrintOutcome> {
  if (!messages.length) return { skipped: [] };
  await ensureBodies(messages, ctx);
  const { bytes, skipped } = await loadAttachmentBytesFor(messages, ctx);
  const subject = ctx.threadSubject || messages[0]?.subject || "conversation";
  triggerDownload(
    new Blob([buildThreadEml(messages, subject, bytes)], { type: "message/rfc822" }),
    `${safeFileBase(subject)}.eml`
  );
  return { skipped };
}

// Bytes for the .eml paths, which need the original files but none of the
// rendering the printable document does.
async function loadAttachmentBytesFor(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<{ bytes: Map<string, ArrayBuffer>; skipped: PrintOutcome["skipped"] }> {
  const all = messages.flatMap((m) => m.attachments ?? []);
  if (all.length === 0) return { bytes: new Map(), skipped: [] };
  const { bytes, skipped } = await loadAttachments(all, ctx.accountId, ctx.threadId);
  return {
    bytes,
    skipped: skipped.map((s) => ({
      filename: s.filename,
      reason: s.reason === "too-large" ? "too large to embed" : "couldn't be downloaded"
    }))
  };
}

function buildThreadEml(
  messages: MissiveMessage[],
  subject: string,
  bytes: Map<string, ArrayBuffer>
): string {
  const last = messages[messages.length - 1];
  const boundary = `----=_ddthread_${messages[0]?.id ?? "t"}`;
  const headers = [
    `From: ${last?.from_addr ?? ""}`,
    `Subject: ${encodeHeaderValue(subject || "(no subject)")}`,
    `Date: ${rfc5322Date(last?.sent_at ?? "")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/digest; boundary="${boundary}"`
  ];
  let out = headers.join(CRLF) + CRLF + CRLF;
  for (const m of messages) {
    out += `--${boundary}${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}`;
    out += buildEml(m, bytes) + CRLF;
  }
  out += `--${boundary}--${CRLF}`;
  return out;
}

function triggerDownload(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

// --- .eml (RFC 5322 / MIME) assembly ---------------------------------------

const CRLF = "\r\n";

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Wrap a base64 blob to 76-char lines (RFC 2045).
function wrapBase64(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? [b64]).join(CRLF);
}

// Encode a header value as an RFC 2047 encoded-word only when it carries
// non-ASCII (e.g. an accented display name in the Subject); plain-ASCII values
// pass through unchanged so common headers stay human-readable.
function encodeHeaderValue(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${utf8ToBase64(s)}?=`;
}

// A MIME parameter such as `filename=`. Plain-ASCII values use the ordinary
// quoted form; anything else uses RFC 2231's charset-tagged extended form, which
// is what mail clients expect for non-Latin filenames.
function mimeParam(name: string, value: string): string {
  if (/^[\x20-\x7E]*$/.test(value) && !/["\\]/.test(value)) {
    return `${name}="${value}"`;
  }
  const pct = Array.from(new TextEncoder().encode(value))
    .map((b) =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
    )
    .join("");
  return `${name}*=UTF-8''${pct}`;
}

function ensureAngle(id: string): string {
  const t = id.trim();
  return t.startsWith("<") ? t : `<${t}>`;
}

// RFC 5322 date, e.g. "Tue, 05 Aug 2025 16:12:00 +0000". toUTCString() gives the
// same shape with a "GMT" zone; swap it for the numeric offset RFC 5322 wants.
function rfc5322Date(iso: string): string {
  const d = new Date(iso);
  const base = Number.isNaN(d.getTime()) ? new Date(0) : d;
  return base.toUTCString().replace(/GMT$/, "+0000");
}

// A MIME entity: its Content-* headers plus its body. Kept separate from the
// message headers so entities can nest (mixed → related → alternative), which is
// what carrying both inline images and file attachments requires.
interface MimeEntity {
  headers: string[];
  body: string;
}

function serializeEntity(e: MimeEntity): string {
  return e.headers.join(CRLF) + CRLF + CRLF + e.body;
}

function multipart(subtype: string, parts: MimeEntity[], seed: string, extra = ""): MimeEntity {
  const boundary = `----=_dd_${subtype}_${seed}`;
  let body = "";
  for (const p of parts) {
    body += `--${boundary}${CRLF}${serializeEntity(p)}${CRLF}`;
  }
  body += `--${boundary}--${CRLF}`;
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"${extra}`],
    body
  };
}

function textEntity(contentType: string, payload: string): MimeEntity {
  return {
    headers: [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64"],
    body: wrapBase64(utf8ToBase64(payload))
  };
}

function attachmentEntity(
  a: MissiveMessageAttachment,
  buf: ArrayBuffer,
  inline: boolean
): MimeEntity {
  const headers = [
    `Content-Type: ${effectiveMime(a)}; ${mimeParam("name", a.filename)}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${inline ? "inline" : "attachment"}; ${mimeParam("filename", a.filename)}`
  ];
  // Strip CR/LF before it reaches a header value — an attachment content_id is
  // remote-supplied, and a newline in it would inject arbitrary headers into
  // the .eml. mimeParam already refuses control characters in filenames; this
  // is the same guard for the one raw header value left.
  if (inline && a.content_id) {
    const cid = a.content_id.replace(/[\r\n]+/g, "");
    if (cid) headers.push(`Content-ID: ${ensureAngle(cid)}`);
  }
  return { headers, body: wrapBase64(bufferToBase64(buf)) };
}

// The message's own content, before attachments: multipart/alternative when we
// have both html and text, otherwise a single text/html or text/plain part.
function bodyEntity(m: MissiveMessage): MimeEntity {
  const html = bodyHtmlOf(m);
  const text = bodyTextOf(m);
  if (html && text) {
    return multipart(
      "alternative",
      [textEntity('text/plain; charset="utf-8"', text), textEntity('text/html; charset="utf-8"', html)],
      m.id
    );
  }
  if (html) return textEntity('text/html; charset="utf-8"', html);
  return textEntity('text/plain; charset="utf-8"', text || "(empty)");
}

function buildEml(m: MissiveMessage, bytes: Map<string, ArrayBuffer>): string {
  const headers: string[] = [`From: ${m.from_addr}`];
  const to = m.to_addrs?.filter(Boolean) ?? [];
  const cc = m.cc_addrs?.filter(Boolean) ?? [];
  if (to.length) headers.push(`To: ${to.join(", ")}`);
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(m.subject || "(no subject)")}`);
  headers.push(`Date: ${rfc5322Date(m.sent_at)}`);
  if (m.message_id) headers.push(`Message-ID: ${ensureAngle(m.message_id)}`);
  if (m.in_reply_to) headers.push(`In-Reply-To: ${ensureAngle(m.in_reply_to)}`);
  headers.push("MIME-Version: 1.0");

  // Split the files we actually have bytes for into the inline images the body
  // references by cid: and the ordinary attachments.
  const atts = (m.attachments ?? []).filter((a) => bytes.has(a.id));
  const html = bodyHtmlOf(m);
  const inlineIds = html ? referencedInlineIds(html, atts) : new Set<string>();
  const inlineAtts = atts.filter((a) => inlineIds.has(a.id));
  const fileAtts = atts.filter((a) => !inlineIds.has(a.id));

  // multipart/related keeps each inline image next to the body that references
  // it, so Outlook can resolve the cid:. Ordinary files hang off an outer
  // multipart/mixed. Neither wrapper is emitted when it has nothing to hold, so
  // a plain message serializes exactly as it did before.
  let entity = bodyEntity(m);
  if (inlineAtts.length) {
    // RFC 2387 §3.1: `type` must be the media type of the ROOT part. When the
    // message has both html and text the root is the multipart/alternative we
    // just built, not text/html — mislabelling it can stop a strict client
    // resolving the cid: references this wrapper exists to make work.
    const rootType = entity.headers[0]?.toLowerCase().includes("multipart/alternative")
      ? "multipart/alternative"
      : "text/html";
    entity = multipart(
      "related",
      [entity, ...inlineAtts.map((a) => attachmentEntity(a, bytes.get(a.id)!, true))],
      m.id,
      `; type="${rootType}"`
    );
  }
  if (fileAtts.length) {
    entity = multipart(
      "mixed",
      [entity, ...fileAtts.map((a) => attachmentEntity(a, bytes.get(a.id)!, false))],
      m.id
    );
  }

  return headers.concat(entity.headers).join(CRLF) + CRLF + CRLF + entity.body;
}
