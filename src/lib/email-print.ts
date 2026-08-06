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

import type { MissiveMessage } from "@/lib/missive-client";
import { getCachedBody, fetchDeferredBody } from "@/lib/message-body-cache";

export interface EmailPrintContext {
  accountId: string;
  threadId: string;
  // Falls back to the first message's subject when omitted.
  threadSubject?: string;
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

// The email's own HTML if we have it (inline or cached), else the plaintext
// wrapped so it keeps its line breaks. Returns a body fragment, already escaped
// where it's plaintext; HTML bodies pass through as the app renders them.
function messageBodyFragment(m: MissiveMessage): string {
  const html = m.body_html ?? getCachedBody(m.id)?.body_html ?? null;
  if (html) return `<div class="dd-body">${html}</div>`;
  const text = m.body_text ?? getCachedBody(m.id)?.body_text ?? null;
  return `<pre class="dd-body-text">${escapeHtml(text || "(empty)")}</pre>`;
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
  @media print {
    .dd-doc { max-width: none; padding: 0; }
    .dd-msg { page-break-inside: avoid; }
  }
`;

function messageBlock(m: MissiveMessage, showSubject: boolean): string {
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
    ${messageBodyFragment(m)}
  </article>`;
}

// Assemble the full standalone HTML document. When more than one message is
// printed we show the shared subject once as a heading and omit the per-message
// Subject row (unless a message's own subject differs).
function buildDocument(messages: MissiveMessage[], ctx: EmailPrintContext): string {
  const threadSubject =
    ctx.threadSubject || messages[0]?.subject || "(no subject)";
  const multi = messages.length > 1;
  const heading = multi
    ? `<h1 class="dd-thread-subject">${escapeHtml(threadSubject)}</h1>`
    : "";
  const blocks = messages
    .map((m) => messageBlock(m, !multi || (m.subject || "") !== threadSubject))
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
): Promise<void> {
  if (!messages.length) return;
  await ensureBodies(messages, ctx);
  const doc = buildDocument(messages, ctx);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
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

  iframe.addEventListener("load", () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    win.addEventListener("afterprint", cleanup);
    // Give late-loading images a moment so they aren't cut from the printout.
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        /* ignore — user can still download */
      }
      // Fallback cleanup in case afterprint never fires (e.g. dialog cancelled).
      setTimeout(cleanup, 60_000);
    }, 350);
  });

  document.body.appendChild(iframe);
}

// Download the given message(s) as a self-contained .html file.
export async function downloadEmails(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<void> {
  if (!messages.length) return;
  await ensureBodies(messages, ctx);
  const doc = buildDocument(messages, ctx);
  const subject = ctx.threadSubject || messages[0]?.subject || "email";

  triggerDownload(
    new Blob([doc], { type: "text/html;charset=utf-8" }),
    `${safeFileBase(subject)}.html`
  );
}

// Download a single message as an RFC-5322 .eml file — the standard email
// interchange format, so the saved message re-opens in Outlook / Apple Mail /
// Thunderbird with its headers and body intact (what "download message" does in
// a real mail client). Single-message only: .eml has no concept of a thread.
// Attachments are NOT embedded yet — the body (html + text) and headers are.
export async function downloadEml(
  message: MissiveMessage,
  ctx: EmailPrintContext
): Promise<void> {
  await ensureBodies([message], ctx);
  const eml = buildEml(message);
  triggerDownload(
    // message/rfc822 is the correct type; the .eml extension is what desktop
    // mail clients register a file association against.
    new Blob([eml], { type: "message/rfc822" }),
    `${safeFileBase(message.subject || ctx.threadSubject || "email")}.eml`
  );
}

// Download a whole thread as a single .eml. An .eml holds one message, so a
// conversation is packed as multipart/digest — the RFC-2046 container for "a
// collection of messages", each an embedded message/rfc822 part built by the
// same per-message assembler. Opens in Outlook / Apple Mail / Thunderbird as one
// item carrying every message in the thread.
export async function downloadThreadEml(
  messages: MissiveMessage[],
  ctx: EmailPrintContext
): Promise<void> {
  if (!messages.length) return;
  await ensureBodies(messages, ctx);
  const subject = ctx.threadSubject || messages[0]?.subject || "conversation";
  triggerDownload(
    new Blob([buildThreadEml(messages, subject)], { type: "message/rfc822" }),
    `${safeFileBase(subject)}.eml`
  );
}

function buildThreadEml(messages: MissiveMessage[], subject: string): string {
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
    out += buildEml(m) + CRLF;
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

function buildEml(m: MissiveMessage): string {
  const html = m.body_html ?? getCachedBody(m.id)?.body_html ?? null;
  const text = m.body_text ?? getCachedBody(m.id)?.body_text ?? null;

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

  const part = (contentType: string, payload: string) =>
    `Content-Type: ${contentType}${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrapBase64(utf8ToBase64(payload));

  let body: string;
  if (html && text) {
    // multipart/alternative — clients pick html, fall back to text.
    const boundary = `----=_dd_${m.id}`;
    headers.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`
    );
    body =
      `--${boundary}${CRLF}` +
      part('text/plain; charset="utf-8"', text) +
      `${CRLF}--${boundary}${CRLF}` +
      part('text/html; charset="utf-8"', html) +
      `${CRLF}--${boundary}--${CRLF}`;
  } else if (html) {
    headers.push('Content-Type: text/html; charset="utf-8"');
    headers.push("Content-Transfer-Encoding: base64");
    body = wrapBase64(utf8ToBase64(html)) + CRLF;
  } else {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    headers.push("Content-Transfer-Encoding: base64");
    body = wrapBase64(utf8ToBase64(text || "(empty)")) + CRLF;
  }

  return headers.join(CRLF) + CRLF + CRLF + body;
}
