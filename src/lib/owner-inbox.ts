import { listAccounts, getThread, type MissiveAccount, type MissiveMessage } from "@/lib/missive-client";
import { OWNER_EMAIL } from "@/lib/access";

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
