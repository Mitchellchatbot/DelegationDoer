import { listAccounts, getThread, type MissiveAccount, type MissiveMessage } from "@/lib/missive-client";
import { OWNER_EMAIL } from "@/lib/access";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { getClients, getMeetingsForClient, type Client } from "@/lib/clients-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Senders that never warrant a personal reply — receipts, no-reply, marketing,
// automated notifications. Dropped before the AI classifier even runs.
const AUTOMATED_FROM = /(no-?reply|do-?not-?reply|notifications?@|mailer|newsletter|statements?@|invoice\+|billing@|receipts?@|updates?@|auto-?confirm|order-?confirm|orders?@|alerts?@|member(ship)?@|marketing@|events?@|news@|digest@|support@wpdeveloper|support@wpremote|@wpremote|wordpress@|@wpenginepowered|@wpengine|@amazon\.|@shopify|@stripe\.com|americanexpress|@aexp|@apple\.com|@meta\.com|facebookmail|@linkedin\.com|pandadoc|docusign|notify\.railway|@railway\.app|calendly|@e\.|@.*mailing|@.*eventbrite|@.*mailchimp|postmaster|via .*mail)/i;
const AUTOMATED_SUBJECT = /(receipt|invoice|statement|out of usage credits|vulnerability notification|weekly .* summary|unsubscribe|newsletter|password reset|verify your email|security alert|new user registration|ordered \d+ item|your order|has shipped|shipping confirmation|registration|\(auto\)|auto update|site update|sync completed|first sync|backup (completed|failed)|update (completed|failed)|card was reactivated|reactivated in apple pay|transaction (declined|approved)|payment (received|failed|declined)|keynote speaker|webinar|register now|save the date|this year'?s|join us|you'?re invited|reminder:|is now available|has been (added|updated|created)|^invitation:|^accepted:|^declined:|has (just )?(viewed|completed)|document has been completed|sent you instructions|deployment crashed|posted a (low )?(rating|review)|new review|contact form)/i;

export interface InboxThreadLite { id: string; subject: string; from: string; snippet: string; lastAt?: string }

export type InboxCategory = "client" | "prospect" | "sales" | "other" | "noise";
export type CategorizedThread<T> = T & { category: InboxCategory; needsReply: boolean };

// Sort the reply-worthy inbox into buckets: existing clients (matched to the
// board by domain), potential clients (prospects/leads), sales pitches TO us,
// and everything else — with a needsReply flag for what actually wants an
// answer. Automated mail is dropped first, same as filterReplyNeeded.
export async function categorizeInbox<T extends InboxThreadLite>(threads: T[]): Promise<CategorizedThread<T>[]> {
  const candidates = threads.filter(
    (t) =>
      !(AUTOMATED_FROM.test(t.from) || AUTOMATED_SUBJECT.test(t.subject)) &&
      // Drop threads whose newest message is Mitchell's own — he isn't waiting
      // on himself; a pitch he sent belongs in Reactivate, not the reply list.
      !t.from.toLowerCase().includes(OWNER_EMAIL)
  );
  if (candidates.length === 0) return [];

  // Client domains from the board — a deterministic "client" signal.
  let clientDomains = new Set<string>();
  try {
    const clients = await getClients();
    const dnorm = (u: string | null | undefined) => {
      if (!u) return "";
      try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); }
      catch { return u.replace(/^www\./, "").toLowerCase(); }
    };
    clientDomains = new Set(
      clients.flatMap((c) => [c.website, ...(c.websites ?? [])]).map(dnorm).filter((d) => d && d.includes("."))
    );
  } catch { /* board unavailable — AI still categorizes */ }

  const domainOf = (from: string) => {
    const m = from.toLowerCase().match(/[\w.+-]+@([\w.-]+)/);
    return m ? m[1].replace(/^www\./, "") : "";
  };

  // AI pass: category + needsReply for each surviving thread.
  const byIdx = new Map<number, { category: InboxCategory; needsReply: boolean }>();
  try {
    const client = await getAnthropic();
    const list = candidates.map((t, i) => `${i}. from: ${t.from} | subject: ${t.subject} | ${t.snippet.slice(0, 160)}`).join("\n");
    const res = await client.messages.create({
      model: MODELS.classify,
      max_tokens: 900,
      system: [
        "You triage a founder's (Mitchell, owner of Scaled AI — a marketing agency for addiction-treatment / behavioral-health centers) inbox. Be STRICT and skeptical: most email is noise, not something he must act on.",
        "For each numbered thread return a category and whether it truly needs a PERSONAL reply from Mitchell.",
        "Categories:",
        "- \"client\": a real person at a company Scaled AI already serves, writing something real.",
        "- \"prospect\": a real person at a POTENTIAL client (a treatment center / business that could hire Scaled AI) — an inbound inquiry or an interested lead.",
        "- \"sales\": a human selling TO Mitchell (cold pitch, vendor, agency, recruiter).",
        "- \"other\": a real person (partner, teammate, personal) who needs his attention.",
        "- \"noise\": anything that is NOT a person writing to him and does not deserve a spot in his action list. Put it here and it is hidden.",
        "ALWAYS classify as \"noise\" (and needsReply=false): automated form/contact-form submissions and lead-form notifications (even from a client's own domain), calendar invites/acceptances/declines (Calendly, Google/Outlook invites, 'Accepted:'/'Invitation:'), review or rating notifications ('posted a low rating', 'new review'), document-view/e-sign notifications (PandaDoc 'viewed the document', DocuSign), receipts, reports, newsletters, product/marketing blasts, platform notifications.",
        "needsReply=true ONLY when a specific human has asked Mitchell a question or made a request and is waiting on his answer. A notification, an FYI, an acceptance, a form, or a cold sales pitch is NEVER needsReply. When unsure, needsReply=false.",
        "Return STRICT JSON only: { \"items\": [ { \"i\": number, \"category\": \"client\"|\"prospect\"|\"sales\"|\"other\"|\"noise\", \"needsReply\": boolean } ] } with one object per thread."
      ].join("\n"),
      messages: [{ role: "user", content: list }]
    });
    const text = res.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
    const json = JSON.parse(text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim());
    for (const it of json.items ?? []) {
      const i = Number(it.i);
      const category = (["client", "prospect", "sales", "other"] as const).includes(it.category) ? it.category : "other";
      if (Number.isInteger(i)) byIdx.set(i, { category, needsReply: !!it.needsReply });
    }
  } catch { /* AI unavailable — fall back to domain-only below */ }

  return candidates
    .map((t, i) => {
      const ai = byIdx.get(i);
      // Noise wins over everything — a contact form from a client domain is
      // still noise, not a "client" reply.
      if (ai?.category === "noise") return { ...t, category: "noise" as InboxCategory, needsReply: false };
      // Otherwise a deterministic client-domain match beats the model's guess.
      const isClient = clientDomains.has(domainOf(t.from));
      const category: InboxCategory = isClient ? "client" : (ai?.category ?? "other");
      const needsReply = ai ? ai.needsReply : false; // no verdict → don't flag
      return { ...t, category, needsReply };
    })
    .filter((t) => t.category !== "noise");
}

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
      system: [
        "You triage a founder's (Mitchell, agency owner) email inbox. For each numbered thread decide if it needs a PERSONAL reply from him.",
        "Return STRICT JSON only: { \"reply\": [indices] } — the indices that need his personal reply.",
        "",
        "INCLUDE only when a real human is genuinely waiting on Mitchell:",
        "- a client, prospect, partner, vendor, or teammate who asked a question, made a request, or needs a decision/answer",
        "- a sales or business conversation where the ball is in his court",
        "- a real person following up or expecting a response",
        "",
        "EXCLUDE everything else, including:",
        "- automated notifications & alerts (bank/Amex/Apple Pay/card, platform notices from Meta/Google/LinkedIn, site/plugin/backup/sync, calendar auto-messages)",
        "- receipts, invoices, statements, order/shipping confirmations",
        "- newsletters, marketing, event/webinar/keynote invites, 'save the date', digests, product announcements",
        "- pure FYI / confirmations that need no response, cold sales pitches TO him",
        "",
        "Be STRICT: when in doubt, EXCLUDE. It is much better to hide a borderline email than to clutter his list. A clean list of only truly must-reply threads is the goal."
      ].join("\n"),
      messages: [{ role: "user", content: list }]
    });
    const text = res.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
    const json = JSON.parse(text.replace(/^```json?\s*/i, "").replace(/```$/, "").trim());
    if (!json || !Array.isArray(json.reply)) return candidates; // unparseable — heuristic set
    const keep = new Set<number>(json.reply.map((n: unknown) => Number(n)));
    return candidates.filter((_, i) => keep.has(i)); // trust the strict classifier, even if that's zero
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

  // Normal reply: to the latest INBOUND sender. But a sent-only thread (a pitch
  // Mitchell sent that never got a reply) has no inbound message — a follow-up
  // there goes to the RECIPIENTS of his last outbound message, not back to him.
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  let to: string[];
  let anchor: MissiveMessage;
  if (lastInbound) {
    anchor = lastInbound;
    to = lastInbound.from_addr ? [lastInbound.from_addr] : [];
  } else {
    const lastOutbound = [...messages].reverse().find((m) => m.direction === "outbound") ?? messages[messages.length - 1];
    anchor = lastOutbound;
    to = (lastOutbound.to_addrs ?? []).filter((a) => a && a.toLowerCase() !== OWNER_EMAIL);
  }
  const baseSubject = anchor.subject || thread?.subject || "";
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`.trim();

  return {
    to,
    subject,
    inReplyTo: anchor.message_id ?? undefined,
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

// Match an email address to a client on the board (by contact email, then by
// website domain, then by a distinctive name token) so a draft can be grounded
// in who they actually are.
function matchClient(email: string, clients: Client[]): Client | null {
  const e = email.toLowerCase();
  const domain = e.includes("@") ? e.split("@")[1] : "";
  const dnorm = (u: string | null | undefined) => {
    if (!u) return "";
    try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); }
    catch { return u.replace(/^www\./, "").toLowerCase(); }
  };
  // 1. exact contact email
  for (const c of clients) if ((c.contactEmails ?? []).some((x) => x.toLowerCase() === e)) return c;
  // 2. website domain match
  if (domain && !FREE_EMAIL.has(domain)) {
    for (const c of clients) {
      const doms = [c.website, ...(c.websites ?? [])].map(dnorm).filter(Boolean);
      if (doms.includes(domain)) return c;
    }
  }
  return null;
}

const FREE_EMAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]);

// Build a rich context block about the client on the other end of a thread:
// who they are, what they pay, their notes/health, and what was said/decided in
// recent meetings — so a drafted reply reflects the real relationship.
export async function clientContextForEmail(email: string): Promise<string> {
  if (!email) return "";
  let clients: Client[];
  try { clients = await getClients(); } catch { return ""; }
  const client = matchClient(email, clients);
  if (!client) return "";

  // MRR from the manual sheet (best-effort name match).
  let mrrLine = "";
  try {
    const { data } = await getSupabaseAdmin().from("mrr_entries").select("company, mrr, status");
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cn = norm(client.name);
    const row = ((data ?? []) as { company: string; mrr: number; status: string }[])
      .find((r) => { const rc = norm(r.company); return rc && (rc.includes(cn) || cn.includes(rc)); });
    if (row) mrrLine = `Pays: $${Math.round(Number(row.mrr)).toLocaleString("en-US")}/mo (${row.status}).`;
  } catch { /* ignore */ }

  // Recent meetings (summary + decisions/next steps).
  let meetingsBlock = "";
  try {
    const meetings = await getMeetingsForClient(client.id);
    const recent = meetings.slice(0, 2);
    meetingsBlock = recent.map((m) => {
      const parts = [`Meeting ${m.meetingDate?.slice(0, 10) ?? ""}: ${m.summary ?? m.title ?? ""}`.trim()];
      if (m.brief?.keyDecisions?.length) parts.push(`  Decisions: ${m.brief.keyDecisions.slice(0, 3).join("; ")}`);
      if (m.brief?.nextSteps?.length) parts.push(`  Next steps: ${m.brief.nextSteps.slice(0, 3).join("; ")}`);
      if (m.brief?.clientRequests?.length) parts.push(`  They asked for: ${m.brief.clientRequests.slice(0, 3).join("; ")}`);
      return parts.join("\n");
    }).join("\n");
  } catch { /* ignore */ }

  const lines = [
    `Client: ${client.name}${client.priority ? ` (priority: ${client.priority})` : ""}.`,
    mrrLine,
    client.notes ? `Notes: ${client.notes.slice(0, 300)}` : "",
    client.healthSummary ? `Health: ${client.healthSummary.slice(0, 300)}` : "",
    client.businessInformation ? `About them: ${client.businessInformation.slice(0, 400)}` : "",
    meetingsBlock ? `Recent meetings:\n${meetingsBlock}` : ""
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : "";
}
