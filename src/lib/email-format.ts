import type { MissiveMessage } from "@/lib/missive-client";

// Pull "Name" out of "Name <email>", or fall back to the local-part of the
// address. Used to label avatars + sender pills.
export function shortName(addr: string): string {
  const m = addr.match(/^"?([^<"]+?)"?\s*<([^>]+)>$/);
  if (m) return m[1].trim();
  const at = addr.indexOf("@");
  return at > 0 ? addr.slice(0, at) : addr;
}

export function rawEmail(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return m ? m[1] : addr;
}

// Split "Name <email@x>" into its two halves. Missive returns from_addr in
// that shape most of the time, but plenty of senders give a bare address and
// a few give a bare name, so each half is independently nullable.
//
// Distinct from shortName/rawEmail above: those always return a string and
// are for rendering, this one is for storing the parts separately.
export function splitAddress(raw: string | null): {
  name: string | null;
  email: string | null;
} {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() || null };
  // Bare address (no display name).
  if (raw.includes("@")) return { name: null, email: raw.trim() };
  return { name: raw.trim(), email: null };
}

// One-line preview from a message body, for notification surfaces (the home
// email card, the desktop widget, the #email-notifs Slack post). Strips HTML
// and collapses whitespace so an HTML-only email still yields readable text.
//
// Longer and more aggressive than messageSnippet below, which is for an
// in-app collapsed stub where the full body is one click away.
export function bodyPreview(
  m: { body_text: string | null; body_html: string | null },
  maxLen = 220
): string | null {
  const raw = m.body_text ?? m.body_html;
  if (!raw) return null;
  const text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

// Compact human-readable byte size for the attachment chip (e.g. "7.2 MB").
export function formatBytes(n: number): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

// One-line preview for a collapsed message stub. Prefers the server-computed
// `snippet` (present on deferred-body responses, where the body itself is
// withheld); otherwise prefers the stored plaintext, falling back to a crude
// tag-strip of the HTML body so HTML-only messages still get a snippet.
export function messageSnippet(
  m: Pick<MissiveMessage, "body_text" | "body_html" | "snippet">
): string {
  const source =
    m.snippet && m.snippet.trim()
      ? m.snippet
      : m.body_text && m.body_text.trim()
        ? m.body_text
        : m.body_html
          ? m.body_html.replace(/<[^>]+>/g, " ")
          : "";
  const t = source.replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}
