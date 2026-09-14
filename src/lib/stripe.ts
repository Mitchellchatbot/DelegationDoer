// Read-only Stripe reader for the owner finance section. Uses a RESTRICTED
// key (STRIPE_SECRET_KEY, rk_live_...) that can only read — never charge,
// refund, or transfer. No SDK dependency; talks to the REST API directly.
//
// Everything here is owner-gated at the call sites (finance page / API). Never
// expose this data to non-owner users.

const API = "https://api.stripe.com/v1";

function key(): string | null {
  const k = process.env.STRIPE_SECRET_KEY;
  return k && k.trim() ? k.trim() : null;
}

// Monthly-equivalent multiplier for a recurring interval.
function monthly(interval: string | undefined, count = 1): number {
  const per = interval === "year" ? 1 / 12 : interval === "week" ? 4.345 : interval === "day" ? 30.4 : 1;
  return per / (count || 1);
}

interface StripePrice {
  unit_amount: number | null;
  currency: string;
  recurring?: { interval?: string; interval_count?: number } | null;
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
  customer: StripeCustomer | string;
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

function cust(s: StripeSub): { id: string; name: string; email: string; domain: string } {
  const c = typeof s.customer === "string" ? { id: s.customer, name: "", email: "" } : s.customer;
  const email = c.email ?? "";
  const domain = email.includes("@") ? email.split("@")[1].toLowerCase() : "";
  return { id: c.id, name: (c.name || email || c.id) ?? "", email, domain };
}

export interface ClientRevenue {
  customerId: string;
  name: string;
  email: string;
  domain: string;
  mrr: number;
  subCount: number;
  since: string; // earliest active sub date
}
export interface RevenueSummary {
  mrr: number;
  activeCount: number;
  clientCount: number;
  clients: ClientRevenue[];
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

// Pull subscriptions and roll them up into a revenue summary. Returns null if
// the key is missing or Stripe is unreachable (page falls back gracefully).
export async function getStripeRevenue(): Promise<RevenueSummary | null> {
  if (!key()) return null;
  let subs: StripeSub[];
  try {
    subs = await getAll("/subscriptions?status=all&expand[]=data.customer");
  } catch {
    return null;
  }
  if (!subs.length) return null;

  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  // Active (incl. trialing) grouped by customer.
  const active = subs.filter((s) => s.status === "active" || s.status === "trialing");
  // Group by email when present (one facility often has several Stripe customer
  // records / subs under the same address), else fall back to customer id.
  const byCust = new Map<string, ClientRevenue>();
  for (const s of active) {
    const c = cust(s);
    const gkey = c.email ? c.email.toLowerCase() : c.id;
    const m = subMrr(s);
    const since = new Date(s.created * 1000).toISOString().slice(0, 10);
    const cur = byCust.get(gkey);
    if (cur) {
      cur.mrr += m;
      cur.subCount += 1;
      if (since < cur.since) cur.since = since;
      if (c.name && (!cur.name || cur.name === cur.email)) cur.name = c.name;
    } else {
      byCust.set(gkey, { customerId: c.id, name: c.name, email: c.email, domain: c.domain, mrr: m, subCount: 1, since });
    }
  }
  const clients = [...byCust.values()].sort((a, b) => b.mrr - a.mrr);
  const mrr = clients.reduce((s, c) => s + c.mrr, 0);

  const newSubs = active.filter((s) => s.created >= monthStart);
  const newThisMonth = newSubs
    .map((s) => ({ ...cust(s), mrr: subMrr(s), since: new Date(s.created * 1000).toISOString().slice(0, 10) }))
    .map(({ name, email, mrr, since }) => ({ name, email, mrr, since }))
    .sort((a, b) => b.mrr - a.mrr);
  const newMrr = newThisMonth.reduce((s, c) => s + c.mrr, 0);

  const churnedSubs = subs.filter((s) => s.status === "canceled" && s.canceled_at && s.canceled_at >= monthStart);
  const churnedThisMonth = churnedSubs
    .map((s) => ({ ...cust(s), mrr: subMrr(s) }))
    .map(({ name, email, mrr }) => ({ name, email, mrr }))
    .sort((a, b) => b.mrr - a.mrr);
  const churnedMrr = churnedThisMonth.reduce((s, c) => s + c.mrr, 0);

  const pastDueSubs = subs.filter((s) => s.status === "past_due" || s.status === "unpaid");
  const pastDue = pastDueSubs
    .map((s) => ({ ...cust(s), mrr: subMrr(s) }))
    .map(({ name, email, mrr }) => ({ name, email, mrr }))
    .sort((a, b) => b.mrr - a.mrr);
  const pastDueMrr = pastDue.reduce((s, c) => s + c.mrr, 0);

  return {
    mrr,
    activeCount: active.length,
    clientCount: clients.length,
    clients,
    newThisMonth,
    newMrr,
    churnedThisMonth,
    churnedMrr,
    pastDue,
    pastDueMrr,
    generatedAt: new Date().toISOString()
  };
}
