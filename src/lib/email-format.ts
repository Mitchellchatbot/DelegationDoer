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

// One-line preview for a collapsed message stub. Prefers the stored plaintext;
// falls back to a crude tag-strip of the HTML body so HTML-only messages still
// get a snippet.
export function messageSnippet(
  m: Pick<MissiveMessage, "body_text" | "body_html">
): string {
  const source =
    m.body_text && m.body_text.trim()
      ? m.body_text
      : m.body_html
        ? m.body_html.replace(/<[^>]+>/g, " ")
        : "";
  const t = source.replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}
