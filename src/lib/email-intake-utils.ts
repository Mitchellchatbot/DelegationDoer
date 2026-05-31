// Shared helpers for building thread bodies before classification.

export function extractEmail(addr: string): string | null {
  const m = addr.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase();
  if (addr.includes("@")) return addr.trim().toLowerCase();
  return null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function threadBodyFromMessages(
  messages: Array<{ from_addr: string; sent_at: string; body_text: string | null; body_html: string | null }>
): string {
  return messages
    .map(
      (m) =>
        `--- ${m.from_addr} @ ${m.sent_at} ---\n${m.body_text ?? stripHtml(m.body_html ?? "")}`
    )
    .join("\n\n");
}

export function missiveThreadUrl(threadId: string): string | null {
  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
  return missiveAppUrl ? `${missiveAppUrl}/?thread=${encodeURIComponent(threadId)}` : null;
}
