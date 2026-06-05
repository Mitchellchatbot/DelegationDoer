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
    .map((m) => `--- ${m.from_addr} @ ${m.sent_at} ---\n${messageBodyText(m)}`)
    .join("\n\n");
}

// Pick the fullest plaintext available for one message. Microsoft Graph
// (M365 inboxes) stores only a ~255-char `bodyPreview` in body_text for HTML
// emails — the full content lives in body_html. A naive `body_text ?? html`
// therefore fed the classifier a truncated stub, so real client mail got
// mis-judged isActionable=false and silently dropped. Use whichever source
// yields more text. IMAP messages (full text/plain in body_text, html often
// empty) are unaffected — body_text wins there.
export function messageBodyText(m: { body_text: string | null; body_html: string | null }): string {
  const text = (m.body_text ?? "").trim();
  const fromHtml = stripHtml(m.body_html ?? "");
  return fromHtml.length > text.length ? fromHtml : text;
}

export function missiveThreadUrl(threadId: string): string | null {
  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
  return missiveAppUrl ? `${missiveAppUrl}/?thread=${encodeURIComponent(threadId)}` : null;
}
