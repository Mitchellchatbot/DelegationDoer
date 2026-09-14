// Read-only Stripe reader for the owner finance section. Uses a RESTRICTED
// key (STRIPE_SECRET_KEY, rk_live_...) that can only read — never charge,
// refund, or transfer. No SDK dependency; talks to the REST API directly.
//
// Everything here is owner-gated at the call sites (finance page / API). Never
// expose this data to non-owner users.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

const API = "https://api.stripe.com/v1";

function key(): string | null {
  const k = process.env.STRIPE_SECRET_KEY;
  return k && k.trim() ? k.trim() : null;
}

function monthly(interval: string | undefined, count = 1): number {
  const per = interval === "year" ? 1 / 12 : interval === "week" ? 4.345 : interval === "day" ? 30.4 : 1;
  return per / (count || 1);
}

interface StripePrice {
  unit_amount: number | null;
  currency: string;
  recurring?: { interval?: string; interval_count?: number } | null;
  nickname?: string | null;
  product?: { name?: string | null } | string | null;
}
interface StripeSubItem {
  price?: StripePrice | null;
  quantity?: number | null;
}
interface StripeCustomer {
  id: string;
  name?: string | null;
  email?: string | null;
}
interface StripeSub {
  id: string;
  status: string;
  created: number;
  canceled_at?: number | null;
  pause_collection?: { behavior?: string } | null;
  customer: StripeCustomer | string;
  plan?: { product?: { name?: string | null } | string | null; nickname?: string | null } | null;
  items?: { data?: StripeSubItem[] } | null;
}

async function getAll(path: string): Promise<StripeSub[]> {
  const k = key();
  if (!k) return [];
  const out: StripeSub[] = [];
  let after: string | null = null;
  for (let page = 0; page < 12; page++) {
    const url = `${API}${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&starting_after=${after}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${k}` }, cache: "no-store" });
    if (!r.ok) break;
    const j = (await r.json()) as { data?: StripeSub[]; has_more?: boolean };
    const data = j.data ?? [];
    out.push(...data);
    if (!j.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}

function subMrr(s: StripeSub): number {
  let cents = 0;
  for (const it of s.items?.data ?? []) {
    const amt = (it.price?.unit_amount ?? 0) * (it.quantity ?? 1);
    cents += amt * monthly(it.price?.recurring?.interval ?? undefined, it.price?.recurring?.interval_count ?? 1);
  }
  return cents / 100;
}

function productName(s: StripeSub): string {
  const p = s.plan?.product;
  if (p && typeof p === "object" && p.name) return p.name;
  const it = (s.items?.data ?? [])[0];
  const ip = it?.price?.product;
  if (ip && typeof ip === "object" && ip.name) return ip.name;
  return s.plan?.nickname || it?.price?.nickname || "";
}

function cust(s: StripeSub): { id: string; name: string; email: string; domain: string } {
  const c = typeof s.customer === "string" ? { id: s.customer, name: "", email: "" } : s.customer;
  const email = (c.email ?? "").toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : "";
  return { id: c.id, name: c.name ?? "", email, domain };
}

const FREE_EMAIL = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "live.com", "msn.com", "me.com", "comcast.net"
]);

const BUSINESSY = /\b(LLC|Inc|Corp|Center|Centers|Recovery|Health|Wellness|Institute|Detox|Pools?|Paving|Construction|Solutions|Systems|Homes?|Group|Marketing|Market|Designs?|Digital|Estates|Billing|Hotline|Support|Company|Treatment|Behavioral|Addiction|Clinic|Services)\b/i;

function normDomain(d: string): string {
  return d.replace(/^www\./, "").toLowerCase();
}
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function hostname(u: string): string {
  try {
    return normDomain(new URL(u.startsWith("http") ? u : `https://${u}`).hostname);
  } catch {
    return normDomain(u);
  }
}

// Generic words that don't identify a client — ignored when matching a
// product name against board client names.
const STOP = new Set([
  "seo", "website", "websites", "hosting", "service", "services", "plan", "package",
  "discount", "discounted", "edits", "updates", "security", "care", "assist", "payment",
  "site", "sites", "management", "deliverables", "setup", "redesign", "web", "the", "for",
  "and", "llc", "inc", "of", "new", "starter", "crate", "call", "tracking", "scaled", "ai",
  "com", "net", "org", "systems", "solutions", "link", "mitchell"
]);
function tokens(s: string): string[] {
  return norm(s.replace(/[^a-z0-9]+/gi, " "))
    ? s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t))
    : [];
}

interface Board {
  byDomain: Map<string, string>; // domain -> client name
  byNameToken: { token: string; name: string }[]; // normalized full name -> name
  tokenIndex: Map<string, Set<string>>; // distinctive word -> client names containing it
}

async function loadBoard(): Promise<Board> {
  const byDomain = new Map<string, string>();
  const byNameToken: { token: string; name: string }[] = [];
  const tokenIndex = new Map<string, Set<string>>();
  try {
    const { data } = await getSupabaseAdmin()
      .from("clients")
      .select("name, website, websites");
    for (const row of (data ?? []) as { name: string; website: string | null; websites: string[] | null }[]) {
      const name = row.name;
      if (!name) continue;
      byNameToken.push({ token: norm(name), name });
      for (const t of tokens(name)) {
        const set = tokenIndex.get(t) ?? new Set<string>();
        set.add(name);
        tokenIndex.set(t, set);
      }
      const urls = [row.website, ...(row.websites ?? [])].filter(Boolean) as string[];
      for (const u of urls) {
        const h = hostname(u);
        if (h && h.includes(".")) byDomain.set(h, name);
      }
    }
  } catch {
    /* board unavailable — resolution falls back to Stripe fields */
  }
  return { byDomain, byNameToken, tokenIndex };
}

// Resolve a subscription to a display company name + a stable grouping key.
// Priority: client-board match by email domain, then a board domain appearing
// in the product name, then a board name matching the email-domain root, then
// a business-looking customer/product name, then the domain, then person/email.
function resolve(s: StripeSub, board: Board): { key: string; name: string; matched: boolean } {
  const c = cust(s);
  const prod = productName(s);
  const emailDomain = c.domain;

  // 1. board by exact email domain
  if (emailDomain && board.byDomain.has(emailDomain)) {
    const name = board.byDomain.get(emailDomain)!;
    return { key: `b:${name}`, name, matched: true };
  }
  // 2. a board domain appears inside the product text (e.g. "Fortifywx.com SEO")
  const prodl = prod.toLowerCase();
  if (prodl) {
    for (const [d, name] of board.byDomain) {
      if (prodl.includes(d)) return { key: `b:${name}`, name, matched: true };
    }
  }
  // 2b. a distinctive product word uniquely identifies one board client
  // (e.g. "Vive SEO" -> "Vive Treatment Centers"). Only accept an unambiguous
  // single match so a shared word like "Villa" (many Villa clients) is skipped.
  for (const t of tokens(prod)) {
    const names = board.tokenIndex.get(t);
    if (names && names.size === 1) {
      const name = [...names][0];
      return { key: `b:${name}`, name, matched: true };
    }
  }
  // 3. board name matches the email-domain root (e.g. playsteppa.com <-> "Play Steppa")
  if (emailDomain && !FREE_EMAIL.has(emailDomain)) {
    const root = norm(emailDomain.split(".")[0]);
    if (root.length > 4) {
      const hit = board.byNameToken.find((b) => b.token === root || (b.token.length > 4 && (b.token.includes(root) || root.includes(b.token))));
      if (hit) return { key: `b:${hit.name}`, name: hit.name, matched: true };
    }
  }

  // Unmatched — pick the best available company-ish display name.
  let name = "";
  if (c.name && BUSINESSY.test(c.name)) name = c.name;
  else if (prod.includes(" - ")) name = prod.split(" - ")[0].trim(); // "Let There Be Light - Hosting"
  else if (emailDomain && !FREE_EMAIL.has(emailDomain)) {
    // Title-case the domain root as a last-resort company label.
    const root = emailDomain.split(".")[0];
    name = root.charAt(0).toUpperCase() + root.slice(1);
  } else name = c.name || prod || c.email || c.id;

  // Group unmatched subs by customer identity so distinct businesses billed to
  // the same person (e.g. Villa vs Empower) stay separate, while multiple subs
  // of one customer record merge.
  const gkey = `c:${(c.name || c.email || c.id).toLowerCase()}`;
  return { key: gkey, name, matched: false };
}

export interface ClientRevenue {
  key: string;
  name: string;
  email: string;
  mrr: number;
  subCount: number;
  since: string;
  matched: boolean;
}
export interface RevenueSummary {
  mrr: number; // live (collecting) only — excludes paused
  activeCount: number; // live subscriptions
  clientCount: number; // live clients
  clients: ClientRevenue[];
  paused: { name: string; email: string; mrr: number; product: string }[];
  pausedMrr: number;
  newThisMonth: { name: string; email: string; mrr: number; since: string }[];
  newMrr: number;
  churnedThisMonth: { name: string; email: string; mrr: number }[];
  churnedMrr: number;
  pastDue: { name: string; email: string; mrr: number }[];
  pastDueMrr: number;
  generatedAt: string;
}

export function isStripeConfigured(): boolean {
  return !!key();
}

export async function getStripeRevenue(): Promise<RevenueSummary | null> {
  if (!key()) return null;
  let subs: StripeSub[];
  try {
    subs = await getAll("/subscriptions?status=all&expand[]=data.customer&expand[]=data.plan.product");
  } catch {
    return null;
  }
  if (!subs.length) return null;

  const board = await loadBoard();
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  const isPaused = (s: StripeSub) => !!s.pause_collection;
  const activeAll = subs.filter((s) => s.status === "active" || s.status === "trialing");
  const live = activeAll.filter((s) => !isPaused(s));
  const pausedSubs = activeAll.filter(isPaused);

  // Live clients grouped by resolved company.
  const byClient = new Map<string, ClientRevenue>();
  for (const s of live) {
    const r = resolve(s, board);
    const c = cust(s);
    const m = subMrr(s);
    const since = new Date(s.created * 1000).toISOString().slice(0, 10);
    const cur = byClient.get(r.key);
    if (cur) {
      cur.mrr += m;
      cur.subCount += 1;
      if (since < cur.since) cur.since = since;
    } else {
      byClient.set(r.key, { key: r.key, name: r.name, email: c.email, mrr: m, subCount: 1, since, matched: r.matched });
    }
  }
  const clients = [...byClient.values()].sort((a, b) => b.mrr - a.mrr);
  const mrr = clients.reduce((s, c) => s + c.mrr, 0);

  const paused = pausedSubs
    .map((s) => ({ name: resolve(s, board).name, email: cust(s).email, mrr: subMrr(s), product: productName(s) }))
    .sort((a, b) => b.mrr - a.mrr);
  const pausedMrr = paused.reduce((s, c) => s + c.mrr, 0);

  const newThisMonth = live
    .filter((s) => s.created >= monthStart)
    .map((s) => ({ name: resolve(s, board).name, email: cust(s).email, mrr: subMrr(s), since: new Date(s.created * 1000).toISOString().slice(0, 10) }))
    .sort((a, b) => b.mrr - a.mrr);
  const newMrr = newThisMonth.reduce((s, c) => s + c.mrr, 0);

  const churnedThisMonth = subs
    .filter((s) => s.status === "canceled" && s.canceled_at && s.canceled_at >= monthStart)
    .map((s) => ({ name: resolve(s, board).name, email: cust(s).email, mrr: subMrr(s) }))
    .sort((a, b) => b.mrr - a.mrr);
  const churnedMrr = churnedThisMonth.reduce((s, c) => s + c.mrr, 0);

  const pastDue = subs
    .filter((s) => s.status === "past_due" || s.status === "unpaid")
    .map((s) => ({ name: resolve(s, board).name, email: cust(s).email, mrr: subMrr(s) }))
    .sort((a, b) => b.mrr - a.mrr);
  const pastDueMrr = pastDue.reduce((s, c) => s + c.mrr, 0);

  return {
    mrr,
    activeCount: live.length,
    clientCount: clients.length,
    clients,
    paused,
    pausedMrr,
    newThisMonth,
    newMrr,
    churnedThisMonth,
    churnedMrr,
    pastDue,
    pastDueMrr,
    generatedAt: new Date().toISOString()
  };
}
