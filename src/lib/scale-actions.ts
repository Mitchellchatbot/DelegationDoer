import "server-only";

import { cache } from "react";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getClients } from "@/lib/clients-data";
import { getLatestTouchpointsByClient, computeTouchpointLabel, daysSince } from "@/lib/client-touchpoint";
import { listThreads } from "@/lib/missive-client";
import { getOwnerAccount, AUTOMATED_SUBJECT } from "@/lib/owner-inbox";
import { OWNER_EMAIL } from "@/lib/access";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import { getOutboundBoard } from "@/lib/outbound-board";
import { getOutboundMeta } from "@/lib/outbound-meta";
import type { OutboundBoardProspect } from "@/lib/outbound-board-types";

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

// Booked-call pipeline follow-ups — the hottest prospects from the outbound
// board (booked calls that haven't closed, and no-response leads to re-touch).
// Read-only: the board's whitelist sends no email/phone, so these are worked on
// the Live board (link in the UI), not drafted here.
export interface FollowUpLead {
  facility: string;
  contact: string | null;
  role: string | null;
  source: string | null;
  stage: string;
  daysInPipeline: number | null;  // since it came in
  lastContacted: string | null;   // YYYY-MM-DD
  nextActionDue: string | null;   // YYYY-MM-DD
}
export interface FollowUps { booked: FollowUpLead[]; noResponse: FollowUpLead[] }

// One board read per server request, shared by the Follow-up tab, the LinkedIn
// list and the KPI strip (the board fetch is slow, so never do it twice).
const readBoardCached = cache(() => getOutboundBoard().catch(() => null));
// Same for the 7-day Meta read — shared by the KPI strip and the Meta card.
const readMetaCached = cache(() => getOutboundMeta(7).catch(() => null));
// The Meta card reads through the same cache so the strip + card share one call.
export function getScaleMeta() { return readMetaCached(); }

// The finances that actually inform SCALING (not a P&L): MRR + average client
// value (from the manual MRR sheet, the source of truth), what the booked
// pipeline is worth if closed, and how many new clients stand between us and the
// next MRR milestone. Everything a "should we pour fuel on growth" call needs.
export interface ScaleFinance {
  mrr: number;
  avgClient: number;
  activeClients: number;
  bookedCalls: number;
  potentialFromBooked: number;
  goal: number;
  clientsToGoal: number;
}
export async function getScaleFinance(goal = 100_000): Promise<ScaleFinance | null> {
  const [mrrRes, board] = await Promise.all([
    getSupabaseAdmin().from("mrr_entries").select("mrr, status"),
    readBoardCached()
  ]);
  const rows = (mrrRes.data ?? []) as { mrr: number; status: string }[];
  const active = rows.filter((r) => r.status === "active" || r.status === "paused");
  if (active.length === 0) return null;
  const mrr = active.reduce((s, r) => s + Number(r.mrr), 0);
  const avgClient = mrr / active.length;
  const bookedCalls = board && board.ok ? board.data.pipeline.booked : 0;
  return {
    mrr: Math.round(mrr),
    avgClient: Math.round(avgClient),
    activeClients: active.length,
    bookedCalls,
    potentialFromBooked: Math.round(bookedCalls * avgClient),
    goal,
    clientsToGoal: avgClient ? Math.max(0, Math.ceil((goal - mrr) / avgClient)) : 0
  };
}

// Top-line SCALE KPIs for the dashboard strip — acquisition, not finance:
// booked calls waiting to close, total pipeline, and Meta leads + CTR for the
// last 7 days vs the prior 7 (real trend where we have it). Both sources fall
// back to last-good cache, so this shows numbers even when the dashboard blips.
export interface ScaleKpi {
  label: string;
  value: string;
  sub: string;
  delta?: { dir: "up" | "down"; text: string; good: boolean };
  hue: "indigo" | "violet" | "sky" | "emerald" | "rose" | "amber";
}
export async function getScaleKpis(): Promise<{ kpis: ScaleKpi[]; stale: boolean }> {
  const [board, meta] = await Promise.all([readBoardCached(), readMetaCached()]);
  const stale = Boolean((board && board.ok && board.stale) || (meta && meta.ok && meta.stale));
  const kpis: ScaleKpi[] = [];

  if (board && board.ok) {
    const p = board.data.pipeline;
    kpis.push({ label: "Booked calls", value: p.booked.toLocaleString("en-US"), sub: "waiting to close", hue: "indigo" });
    kpis.push({ label: "Pipeline", value: p.total.toLocaleString("en-US"), sub: `${p.notBooked.toLocaleString("en-US")} not yet booked`, hue: "violet" });
  } else {
    kpis.push({ label: "Booked calls", value: "—", sub: "dashboard unavailable", hue: "indigo" });
    kpis.push({ label: "Pipeline", value: "—", sub: "dashboard unavailable", hue: "violet" });
  }

  if (meta && meta.ok) {
    const t = meta.data.totals;
    const prior = meta.data.priorTotals;
    const leads = t.leads ?? 0;
    const leadDelta = prior?.leads != null
      ? { dir: (leads >= prior.leads ? "up" : "down") as "up" | "down", text: `${leads - prior.leads >= 0 ? "+" : ""}${leads - prior.leads} vs prior 7d`, good: leads >= prior.leads }
      : undefined;
    kpis.push({ label: "Leads · 7d", value: leads.toLocaleString("en-US"), sub: "from our Meta ads", delta: leadDelta, hue: leads === 0 ? "rose" : "emerald" });
    const ctr = t.ctr;
    const ctrDelta = ctr != null && prior?.ctr != null
      ? { dir: (ctr >= prior.ctr ? "up" : "down") as "up" | "down", text: `${ctr >= prior.ctr ? "+" : ""}${(ctr - prior.ctr).toFixed(2)} pts`, good: ctr >= prior.ctr }
      : undefined;
    kpis.push({ label: "Meta CTR · 7d", value: ctr == null ? "—" : `${ctr.toFixed(2)}%`, sub: `$${Math.round(t.spend ?? 0)} spent`, delta: ctrDelta, hue: "sky" });
  } else {
    kpis.push({ label: "Leads · 7d", value: "—", sub: "dashboard unavailable", hue: "sky" });
    kpis.push({ label: "Meta CTR · 7d", value: "—", sub: "dashboard unavailable", hue: "sky" });
  }

  return { kpis, stale };
}

export async function getFollowUpLeads(bookedLimit = 20, noRespLimit = 20): Promise<FollowUps> {
  const res = await readBoardCached();
  if (!res || !res.ok) return { booked: [], noResponse: [] };
  const map = (p: OutboundBoardProspect): FollowUpLead => ({
    facility: p.facility || p.website || "Unknown facility",
    contact: p.name,
    role: p.role,
    source: p.source,
    stage: p.stage,
    daysInPipeline: p.createdAt ? Math.max(0, Math.floor((Date.now() - Date.parse(p.createdAt)) / 86_400_000)) : null,
    lastContacted: p.lastContactedAt,
    nextActionDue: p.nextActionAt
  });
  // Booked (+ proposal) = your close list. Oldest in pipeline first — those are
  // the calls most at risk of going cold.
  const booked = res.data.prospects
    .filter((p) => p.stage === "booked" || p.stage === "proposal")
    .map(map)
    .sort((a, b) => (b.daysInPipeline ?? 0) - (a.daysInPipeline ?? 0))
    .slice(0, bookedLimit);
  // No-response = re-touch list. Longest since last contact first.
  const noResponse = res.data.prospects
    .filter((p) => p.stage === "no_response")
    .map(map)
    .sort((a, b) => (a.lastContacted || "").localeCompare(b.lastContacted || ""))
    .slice(0, noRespLimit);
  return { booked, noResponse };
}

// The daily "5 people to message on LinkedIn" list — ICP decision-makers from
// the live pipeline (warmest first: booked, then no-response, then new). Rotates
// day to day so it's a fresh 5 each morning. Read-only: LinkedIn's API can't send
// DMs or connection requests, so Mitchell (or Dripify) works these by hand.
export interface LinkedInTarget {
  facility: string;
  contact: string;
  role: string | null;
  source: string | null;
  stage: string;
}
const ICP_ROLE = /(ceo|chief executive|founder|owner|president|executive director|clinical director|coo|chief operating|director of (admissions|business))/i;

export async function getLinkedInTargets(count = 5): Promise<LinkedInTarget[]> {
  const res = await readBoardCached();
  if (!res || !res.ok) return [];
  const rank = (stage: string) => (stage === "booked" || stage === "proposal" ? 0 : stage === "no_response" ? 1 : stage === "new" ? 2 : 3);
  const pool = res.data.prospects
    .filter((p) => p.name && p.name.trim() && p.role && ICP_ROLE.test(p.role) && p.stage !== "won" && p.stage !== "lost")
    .sort((a, b) => rank(a.stage) - rank(b.stage));
  if (pool.length === 0) return [];
  // Rotate the window by day-of-year so it's a different 5 most days, but always
  // keep the warmest tier at the front.
  const dayOffset = Math.floor(Date.now() / 86_400_000) % Math.max(1, pool.length);
  const rotated = [...pool.slice(dayOffset), ...pool.slice(0, dayOffset)];
  return rotated.slice(0, count).map((p) => ({
    facility: p.facility || p.website || "Unknown facility",
    contact: p.name as string,
    role: p.role,
    source: p.source,
    stage: p.stage
  }));
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
