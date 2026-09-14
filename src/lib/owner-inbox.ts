import { listAccounts, getThread, type MissiveAccount, type MissiveMessage } from "@/lib/missive-client";
import { OWNER_EMAIL } from "@/lib/access";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";

// Senders that never warrant a personal reply — receipts, no-reply, marketing,
// automated notifications. Dropped before the AI classifier even runs.
const AUTOMATED_FROM = /(no-?reply|do-?not-?reply|notifications?@|mailer|newsletter|statements?@|invoice\+|billing@|receipts?@|updates?@|auto-?confirm|order-?confirm|orders?@|support@wpdeveloper|wordpress@|@wpenginepowered|@wpengine|@amazon\.|@shopify|@stripe\.com|@e\.|@.*mailing|postmaster|via .*mail)/i;
const AUTOMATED_SUBJECT = /(receipt|invoice|statement|out of usage credits|vulnerability notification|weekly .* summary|unsubscribe|newsletter|password reset|verify your email|security alert|new user registration|ordered \d+ item|your order|has shipped|shipping confirmation|registration)/i;

export interface InboxThreadLite { id: string; subject: string; from: string; snippet: string; lastAt?: string }

// Keep only threads that plausibly need a personal reply from Mitchell. A cheap
// heuristic drops obvious automated mail, then Haiku classifies the rest so the
// cockpit shows the emails that actually need answering — nothing else.
export async function filterReplyNeeded<T extends InboxThreadLite>(threads: T[]): Promise<T[]> {
  const candidates = threads.filter(
    (t) => !(AUTOMATED_FROM.test(t.from) || AUTOMATED_SUBJECT.test(t.subject))
  );
  if (candidates.length === 0) return [];

  try {
    const client = await getAnthropic();
    const list = candidates
      .map((t, i) => `${i}. from: ${t.from} | subject: ${t.subject} | ${t.snippet.slice(0, 160)}`)
      .join("\n");
    const res = await client.messages.create({
      model: MODELS.classify,
      max_tokens: 300,
      system:
        "You triage a founder's email inbox. Given a numbered list of threads, return STRICT JSON { \"reply\": [indices] } listing ONLY the threads that need a personal reply FROM the founder — real people asking questions, client conversations, sales/prospect threads, anything awaiting his answer. EXCLUDE automated notifications, receipts, newsletters, marketing, calendar/system auto-messages, and FYI-only mail that needs no response. When unsure, lean toward excluding.",
      messages: [{ role: "user", content: list }]
    });
    const text = res.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
    const json = JSON.parse(text.replace(/^```json?\s*/i, "").replace(/```$/, "").trim());
    const keep = new Set<number>((json.reply ?? []).map((n: unknown) => Number(n)));
    const picked = candidates.filter((_, i) => keep.has(i));
    return picked.length ? picked : candidates; // fall back to heuristic set if the model returned nothing usable
  } catch {
    return candidates; // AI unavailable — heuristic filter is still better than the raw inbox
  }
}

// Helpers for the owner Inbox cockpit: resolve Mitchell's Missive account and
// derive safe reply routing from a thread server-side (never trust the client
// for who a reply goes to / which account it sends from).

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|li|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function getOwnerAccount(): Promise<MissiveAccount | null> {
  const accounts = await listAccounts();
  return accounts.find((a) => (a.email ?? "").toLowerCase() === OWNER_EMAIL) ?? null;
}

export interface ReplyRouting {
  to: string[];
  subject: string;
  inReplyTo?: string;
  fromAccountId: string;
  messages: MissiveMessage[];
}

// Fetch a thread and compute how a reply from Mitchell should be routed:
// reply to the latest INBOUND sender, thread on its message-id, send from
// Mitchell's account. Returns null if the thread can't be resolved.
export async function deriveReply(threadId: string): Promise<ReplyRouting | null> {
  const [detail, owner] = await Promise.all([getThread(threadId), getOwnerAccount()]);
  const messages = detail?.messages ?? [];
  const thread = detail?.thread;
  if (!messages.length || !owner) return null;

  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound") ?? messages[messages.length - 1];
  const to = lastInbound.from_addr ? [lastInbound.from_addr] : [];
  const baseSubject = lastInbound.subject || thread?.subject || "";
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`.trim();

  return {
    to,
    subject,
    inReplyTo: lastInbound.message_id ?? undefined,
    fromAccountId: owner.id,
    messages
  };
}

// Build the chronological transcript passed to the model for drafting.
export function transcriptFor(messages: MissiveMessage[], limit = 6): string {
  return messages.slice(-limit).map((m, idx) => {
    const direction = m.direction === "outbound" ? "SENT" : "RECEIVED";
    const raw = (m.body_text || stripHtml(m.body_html || "")).replace(/\s+\n/g, "\n").trim();
    const capped = raw.length > 2000 ? raw.slice(0, 2000) + " […truncated…]" : raw;
    return `[#${idx + 1} ${direction}] From: ${m.from_addr || "(unknown)"}\nSubject: ${m.subject || "(no subject)"}\n\n${capped}`;
  }).join("\n\n---\n\n");
}
