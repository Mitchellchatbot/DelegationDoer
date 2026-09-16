import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getClients } from "@/lib/clients-data";
import { getLatestTouchpointsByClient, computeTouchpointLabel, daysSince } from "@/lib/client-touchpoint";
import { listThreads } from "@/lib/missive-client";
import { getOwnerAccount, AUTOMATED_SUBJECT } from "@/lib/owner-inbox";
import { OWNER_EMAIL } from "@/lib/access";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { getFacebookRevenue } from "@/lib/facebook-revenue";

// Two owner-only "Act now" modules for the Scale Room:
//   Reach out  — paying clients who've gone quiet (no personal email in a while)
//   Reactivate — cold outbound pitches/booked leads worth chasing again
// Both are ranked by value so the biggest dollars surface first.

export interface ReachOutClient {
  id: string;
  name: string;
  mrr: number;
  days: number | null;      // days since last real outbound email; null = never
  lastSubject: string | null;
  contactEmail: string | null;
}

// Match a client's board name to its manual-MRR row (fuzzy, like elsewhere).
function mrrLookup(rows: { company: string; mrr: number; status: string }[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const active = rows.filter((r) => r.status === "active" || r.status === "paused").map((r) => ({ k: norm(r.company), mrr: Number(r.mrr) }));
  return (name: string) => {
    const k = norm(name);
    if (!k) return 0;
    const hit = active.find((r) => r.k && (r.k.includes(k) || k.includes(r.k)));
    return hit?.mrr ?? 0;
  };
}

// Paying clients with no real outbound email in 10+ days (or never), biggest
// MRR first — the retention gap the 2-week cadence is meant to close.
export async function getReachOutClients(limit = 8): Promise<ReachOutClient[]> {
  const [clients, mrrRes] = await Promise.all([
    getClients().catch(() => []),
    getSupabaseAdmin().from("mrr_entries").select("company, mrr, status")
  ]);
  if (!clients.length) return [];
  const mrrOf = mrrLookup((mrrRes.data ?? []) as { company: string; mrr: number; status: string }[]);
  const touch = await getLatestTouchpointsByClient(clients.map((c) => c.id)).catch(() => new Map());

  const rows: ReachOutClient[] = [];
  for (const c of clients) {
    const mrr = mrrOf(c.name);
    if (mrr <= 0) continue; // focus on paying relationships
    const t = touch.get(c.id);
    const last = t?.lastOutboundEmailAt ?? null;
    if (computeTouchpointLabel(last) !== "red") continue; // only quiet ones (10+ days / never)
    rows.push({
      id: c.id,
      name: c.name,
      mrr,
      days: daysSince(last),
      lastSubject: t?.lastOutboundSubject ?? null,
      contactEmail: c.contactEmails?.[0] ?? null
    });
  }
  // Biggest MRR first; among equals, the longest-quiet first (null days = never = last).
  rows.sort((a, b) => b.mrr - a.mrr || (b.days ?? 1e9) - (a.days ?? 1e9));
  return rows.slice(0, limit);
}

// A pitch/sales email Mitchell SENT that never got a reply — a thread in the
// Sent folder whose last activity is his own outbound message, gone quiet.
// Same shape the inbox uses so the Scale Room renders it with the identical
// draft-follow-up-and-send flow (the reply routes to the recipient).
export interface ReactivatePitch {
  id: string;
  subject: string;
  from: string;        // the recipient he pitched (shown in the row)
  snippet: string;
  lastAt: string;
  daysSilent: number;
}

const INTERNAL = /@scaledai\.org\s*>?\s*$/i;
function displayRecipient(participants: string[], ownerEmail: string): string | null {
  for (const p of participants) {
    if (!p) continue;
    if (p.toLowerCase().includes(ownerEmail)) continue;
    return p;
  }
  return null;
}

// Pitches/sales he sent that went silent: Sent-folder threads whose newest
// message is his outbound, 4–60 days old, to an outside recipient (not internal).
// Most-recently-cold first (warmest to revive). Fail-soft to [].
export async function getReactivatePitches(limit = 15): Promise<ReactivatePitch[]> {
  let threads;
  let owner;
  let clients;
  try {
    [threads, owner, clients] = await Promise.all([
      listThreads({ folder: "SENT", status: "open", limit: 200 }),
      getOwnerAccount(),
      getClients().catch(() => [])
    ]);
  } catch {
    return [];
  }
  let mrrRows: { company: string }[] = [];
  try {
    const { data } = await getSupabaseAdmin().from("mrr_entries").select("company");
    mrrRows = (data ?? []) as { company: string }[];
  } catch { /* MRR sheet unavailable — board names still exclude clients */ }

  // Facebook-side clients (Alter BH, Recovery Unplugged, etc.) live only in the
  // Finance app's payer list, not the board or MRR sheet — pull them so they're
  // excluded too. Fail-soft.
  let fbPayerNames: string[] = [];
  try {
    const fb = await getFacebookRevenue();
    if (fb.ok) fbPayerNames = fb.data.payers.map((p) => p.name);
  } catch { /* Finance app unavailable — other lists still exclude clients */ }
  const ownerEmail = (owner?.email ?? OWNER_EMAIL).toLowerCase();
  const now = Date.now();

  // Existing-client domains — Reactivate is for PROSPECTS only, never someone
  // we already serve (following up a client is not "reactivation").
  const dnorm = (u: string | null | undefined) => {
    if (!u) return "";
    try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); }
    catch { return u.replace(/^www\./, "").toLowerCase(); }
  };
  const clientDomains = new Set(
    (clients ?? []).flatMap((c) => [c.website, ...(c.websites ?? [])]).map(dnorm).filter((d) => d && d.includes("."))
  );
  const clientEmails = new Set((clients ?? []).flatMap((c) => c.contactEmails ?? []).map((e) => e.toLowerCase()));
  // The board often lacks a website domain, so also match the recipient's
  // domain ROOT against client NAMES (changestreatment.com <-> "Changes
  // Treatment", questiop.com <-> "Quest IOP", fountainhillsrecovery.com <->
  // "Fountain Hills Recovery").
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  // "Client" spans the board AND the manual MRR sheet (Facebook-side clients like
  // Alter BH, Ojai, Recovery Unplugged live there, not the board).
  const clientNameTokens = [...(clients ?? []).map((c) => c.name), ...mrrRows.map((r) => r.company), ...fbPayerNames]
    .map(norm)
    .filter((n) => n.length >= 5);
  const domainOf = (addr: string) => {
    const m = addr.toLowerCase().match(/[\w.+-]+@([\w.-]+)/);
    return m ? m[1].replace(/^www\./, "") : "";
  };
  const isClientRecipient = (addr: string): boolean => {
    const rl = addr.toLowerCase();
    if (clientEmails.has(rl)) return true;
    const dom = domainOf(addr);
    if (!dom) return false;
    if (clientDomains.has(dom)) return true;
    const root = norm(dom.split(".")[0]);
    if (root.length < 5) return false;
    return clientNameTokens.some((n) => n === root || n.includes(root) || root.includes(n));
  };

  const out: ReactivatePitch[] = [];
  for (const t of threads) {
    const lastFrom = (t.last_from ?? "").toLowerCase();
    // Newest message must be HIS (i.e. no client reply after his send).
    if (!lastFrom.includes(ownerEmail)) continue;
    const sentAt = t.last_outbound_at ?? t.last_message_at;
    if (!sentAt) continue;
    const daysSilent = Math.max(0, Math.floor((now - Date.parse(sentAt)) / 86_400_000));
    if (daysSilent > 360) continue; // every prospect pitch from the last 360 days with no reply — including today's
    // Drop non-pitch noise (invoices, calendar invites, onboarding/ops notices).
    if (AUTOMATED_SUBJECT.test(t.subject || "")) continue;
    const recipient = displayRecipient(t.participants ?? [], ownerEmail);
    if (!recipient || INTERNAL.test(recipient)) continue; // skip internal team threads
    if (isClientRecipient(recipient)) continue; // prospects only — no existing clients
    out.push({
      id: t.id,
      subject: t.subject || "(no subject)",
      from: recipient,
      snippet: t.last_snippet ?? "",
      lastAt: sentAt,
      daysSilent
    });
  }
  out.sort((a, b) => a.daysSilent - b.daysSilent); // most-recently-cold first

  // The deterministic pass still lets through non-pitches (invoices, calendar
  // invites, onboarding/ops for people already engaged). An AI pass keeps ONLY
  // genuine sales pitches / outreach to a potential client awaiting a reply.
  const pitches = await keepPitches(out.slice(0, 40));
  return pitches.slice(0, limit);
}

// Classify sent threads: keep only real prospect pitches/outreach, drop invoices,
// receipts, calendar invites, onboarding/service ops, and internal notes. Falls
// back to the deterministic set if the model is unavailable.
async function keepPitches(rows: ReactivatePitch[]): Promise<ReactivatePitch[]> {
  if (rows.length === 0) return rows;
  try {
    const client = await getAnthropic();
    const list = rows.map((r, i) => `${i}. to: ${r.from} | subject: ${r.subject} | ${r.snippet.slice(0, 140)}`).join("\n");
    const res = await client.messages.create({
      model: MODELS.classify,
      max_tokens: 400,
      system: [
        "You review emails Mitchell (founder of Scaled AI, a marketing agency for treatment centers) SENT that got no reply.",
        "Keep ONLY genuine sales pitches or business-development outreach to a POTENTIAL client — a cold or warm pitch, a follow-up on a pitch, a proposal, a 'let's talk' to a prospect.",
        "DROP everything else: invoices, receipts, calendar invites/scheduling, onboarding or service/ops emails to someone already working with us, internal notes, reports, anything administrative.",
        "Return STRICT JSON only: { \"keep\": [indices] } — the indices that are real prospect pitches worth reviving."
      ].join("\n"),
      messages: [{ role: "user", content: list }]
    });
    const text = res.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
    const json = JSON.parse(text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim());
    if (!Array.isArray(json.keep)) return rows;
    const keep = new Set<number>(json.keep.map((n: unknown) => Number(n)));
    return rows.filter((_, i) => keep.has(i));
  } catch {
    return rows;
  }
}
