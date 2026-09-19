// Learnings, risk model, projections and scaling analysis over the P&L history.
// Normalized profit strips taxes + one-off write-offs (Mitchell flags these as
// tax-only, not operating). Focus: growth, software spend, the Facebook
// contribution, and client-concentration risk.

export interface PnlMonth {
  period: string; label: string;
  income: number; expenses: number; net: number;
  taxes: number; writeoffs: number;
  software: number; contractors: number; advertising: number;
}
export interface SoftwareItem { vendor: string; month: string; amount: number; segment?: string }
export interface MrrClient { company: string; mrr: number }

export interface TrendPoint { label: string; revenue: number; normalizedNet: number; margin: number; software: number }
export interface RiskItem { title: string; severity: "high" | "medium" | "low"; detail: string; mitigation: string }
export interface ProjMonth { label: string; revenue: number; net: number }
export interface VendorAmt { vendor: string; amount: number }

export interface Learnings {
  hasData: boolean;
  latest: { label: string; revenue: number; normalizedNet: number; margin: number };
  series: TrendPoint[];
  revenueTrendPct: number;   // last vs first
  netPeak: number; netPeakLabel: string;
  netDeclinePct: number;     // latest vs peak (negative = down)
  marginNow: number; marginPeak: number;
  software: { first: number; last: number; growthPct: number; topVendors: VendorAmt[]; rising: VendorAmt[] };
  facebook: { hasData: boolean; revenue: number; profitBeforeCommission: number; sharePct: number; impliedSeoRevenue: number; preFbAvgRevenue: number; seoDeltaPct: number };
  concentration: { top: { name: string; mrr: number; pct: number }[]; top3Pct: number; totalMrr: number };
  projection: { months: ProjMonth[]; annualRunRate: number; softwareDragPerMo: number };
  risks: RiskItem[];
  scale: string[];
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const round = (n: number) => Math.round(n);

export function computeLearnings(input: {
  pnl: PnlMonth[];
  fbRevenueByPeriod?: Record<string, number>;
  fbExpensesByPeriod?: Record<string, number>;
  softwareItems?: SoftwareItem[];
  mrrClients?: MrrClient[];
}): Learnings {
  const pnl = [...(input.pnl ?? [])].sort((a, b) => a.period.localeCompare(b.period));
  const { fbRevenueByPeriod = {}, fbExpensesByPeriod = {}, softwareItems = [], mrrClients = [] } = input;

  const empty: Learnings = {
    hasData: false, latest: { label: "", revenue: 0, normalizedNet: 0, margin: 0 }, series: [],
    revenueTrendPct: 0, netPeak: 0, netPeakLabel: "", netDeclinePct: 0, marginNow: 0, marginPeak: 0,
    software: { first: 0, last: 0, growthPct: 0, topVendors: [], rising: [] },
    facebook: { hasData: false, revenue: 0, profitBeforeCommission: 0, sharePct: 0, impliedSeoRevenue: 0, preFbAvgRevenue: 0, seoDeltaPct: 0 },
    concentration: { top: [], top3Pct: 0, totalMrr: 0 },
    projection: { months: [], annualRunRate: 0, softwareDragPerMo: 0 }, risks: [], scale: []
  };
  if (pnl.length === 0) return empty;

  const norm = (m: PnlMonth) => round(m.net + m.taxes + m.writeoffs);
  const series: TrendPoint[] = pnl.map((m) => ({ label: m.label, revenue: round(m.income), normalizedNet: norm(m), margin: pct(norm(m), m.income), software: round(m.software) }));
  const last = pnl[pnl.length - 1];
  const first = pnl[0];
  const latest = { label: last.label, revenue: round(last.income), normalizedNet: norm(last), margin: pct(norm(last), last.income) };

  const revenueTrendPct = pct(round(last.income) - round(first.income), round(first.income));
  // Peak normalized net excluding obvious one-off anomaly months isn't needed —
  // the peak is a real month; the decline to latest is what matters.
  let netPeak = -Infinity, netPeakLabel = "";
  for (const m of pnl) { const n = norm(m); if (n > netPeak) { netPeak = n; netPeakLabel = m.label; } }
  const netDeclinePct = netPeak ? Math.round(((norm(last) - netPeak) / netPeak) * 100) : 0;
  const marginNow = latest.margin;
  const marginPeak = Math.max(...pnl.map((m) => pct(norm(m), m.income)));

  // ── Software forensics ─────────────────────────────────────────────────────
  const swFirst = round(first.software), swLast = round(last.software);
  const swGrowthPct = pct(swLast - swFirst, swFirst);
  // Vendor detail is available for recent months only (software_subscriptions).
  const swMonths = [...new Set(softwareItems.map((s) => s.month))];
  const lastSwMonth = last.label.slice(0, 3);
  const prevSwMonth = swMonths.find((mm) => mm.slice(0, 3).toLowerCase() !== lastSwMonth.toLowerCase());
  const byVendorLast = new Map<string, number>();
  const byVendorPrev = new Map<string, number>();
  for (const s of softwareItems) {
    if (s.month.slice(0, 3).toLowerCase() === lastSwMonth.toLowerCase()) byVendorLast.set(s.vendor, (byVendorLast.get(s.vendor) ?? 0) + Number(s.amount));
    else if (prevSwMonth && s.month === prevSwMonth) byVendorPrev.set(s.vendor, (byVendorPrev.get(s.vendor) ?? 0) + Number(s.amount));
  }
  const topVendors = [...byVendorLast.entries()].map(([vendor, amount]) => ({ vendor, amount: round(amount) })).sort((a, b) => b.amount - a.amount).slice(0, 6);
  const rising = [...byVendorLast.entries()].map(([vendor, amount]) => ({ vendor, amount: round(amount - (byVendorPrev.get(vendor) ?? 0)) })).filter((v) => v.amount > 50).sort((a, b) => b.amount - a.amount).slice(0, 5);

  // ── Facebook contribution ──────────────────────────────────────────────────
  const fbRev = round(fbRevenueByPeriod[last.period] ?? 0);
  const fbExp = round(fbExpensesByPeriod[last.period] ?? 0);
  const fbHas = last.period in fbRevenueByPeriod;
  const impliedSeo = round(last.income) - fbRev;
  // Pre-Facebook baseline = average total revenue over the first up-to-6 months.
  const preN = Math.min(6, pnl.length);
  const preFbAvgRevenue = round(pnl.slice(0, preN).reduce((s, m) => s + m.income, 0) / preN);
  const seoDeltaPct = pct(impliedSeo - preFbAvgRevenue, preFbAvgRevenue);
  const facebook = { hasData: fbHas, revenue: fbRev, profitBeforeCommission: fbRev - fbExp, sharePct: pct(fbRev, round(last.income)), impliedSeoRevenue: impliedSeo, preFbAvgRevenue, seoDeltaPct };

  // ── Client concentration ───────────────────────────────────────────────────
  const clients = mrrClients.filter((c) => (c.mrr || 0) > 0).sort((a, b) => (b.mrr || 0) - (a.mrr || 0));
  const totalMrr = clients.reduce((s, c) => s + (c.mrr || 0), 0);
  const top = clients.slice(0, 5).map((c) => ({ name: c.company, mrr: round(c.mrr), pct: pct(c.mrr, totalMrr) }));
  const top3Pct = pct(clients.slice(0, 3).reduce((s, c) => s + (c.mrr || 0), 0), totalMrr);

  // ── Projection (run-rate of the last 3 months) ─────────────────────────────
  const last3 = pnl.slice(-3);
  const avgRev = round(last3.reduce((s, m) => s + m.income, 0) / last3.length);
  const avgNet = round(last3.reduce((s, m) => s + norm(m), 0) / last3.length);
  const softwareDragPerMo = pnl.length >= 4 ? round((swLast - round(pnl[pnl.length - 4].software)) / 3) : 0;
  const nextLabels = nextThree(last.label);
  const projection = {
    months: nextLabels.map((label, i) => ({ label, revenue: avgRev, net: Math.max(0, avgNet - softwareDragPerMo * (i + 1)) })),
    annualRunRate: avgNet * 12,
    softwareDragPerMo
  };

  // ── Risk model ─────────────────────────────────────────────────────────────
  const risks: RiskItem[] = [];
  if (top3Pct >= 25) risks.push({ title: `Client concentration — top 3 = ${top3Pct}% of recurring revenue`, severity: top3Pct >= 40 ? "high" : "medium", detail: `Your 3 biggest clients are ${top3Pct}% of MRR ($${top.slice(0, 3).reduce((s, c) => s + c.mrr, 0).toLocaleString()}/mo). Losing one is a material hit.`, mitigation: "Lock 6–12 mo agreements with the top 3, deepen the relationship, and win mid-size clients to dilute the share." });
  if (netDeclinePct <= -20) risks.push({ title: `Margin compression — profit down ${Math.abs(netDeclinePct)}% from peak`, severity: "high", detail: `Normalized profit fell from $${round(netPeak).toLocaleString()} (${netPeakLabel}) to $${latest.normalizedNet.toLocaleString()} (${latest.label}) on flat revenue — costs are eating the business.`, mitigation: "Cut software, cap contractor growth, and raise fees on the concentrated clients." });
  if (Math.abs(revenueTrendPct) < 12) risks.push({ title: "Revenue is flat — growth has stalled", severity: "high", detail: `Total revenue moved only ${revenueTrendPct >= 0 ? "+" : ""}${revenueTrendPct}% across ${pnl.length} months (~$${Math.round(pnl.reduce((s, m) => s + m.income, 0) / pnl.length / 1000)}K/mo).`, mitigation: "Client acquisition is the constraint — Apollo / LinkedIn / Meta pipeline is the highest-leverage lever." });
  if (swGrowthPct >= 40) risks.push({ title: `Software creep — up ${swGrowthPct}% to $${swLast.toLocaleString()}/mo`, severity: "medium", detail: `Software went from $${swFirst.toLocaleString()} to $${swLast.toLocaleString()}/mo${rising.length ? `; biggest recent adds: ${rising.slice(0, 3).map((v) => v.vendor).join(", ")}.` : "."}`, mitigation: "Audit the recent additions and WordPress; cut/consolidate $2–4K/mo with no revenue tie." });
  if (facebook.hasData && facebook.sharePct >= 12 && seoDeltaPct <= -5) risks.push({ title: `Facebook is masking a softer core (SEO ~${seoDeltaPct}%)`, severity: "medium", detail: `Facebook is $${fbRev.toLocaleString()}/mo (${facebook.sharePct}% of revenue). Implied SEO revenue ($${impliedSeo.toLocaleString()}) is ${seoDeltaPct}% below the pre-Facebook average — FB is filling the gap while the core softens.`, mitigation: "Protect + grow SEO (retention, upsell) so total growth isn't dependent on one channel." });
  risks.push({ title: "Books are being restated month to month", severity: "medium", detail: "Jan and Mar show materially different figures across P&L exports — decisions are riding on moving numbers.", mitigation: "Lock a monthly close with the accountant so history stops shifting." });
  const sevRank: Record<RiskItem["severity"], number> = { high: 3, medium: 2, low: 1 };
  risks.sort((a, b) => sevRank[b.severity] - sevRank[a.severity]);

  // ── Scale levers ───────────────────────────────────────────────────────────
  const scale = [
    "Grow the pipeline — flat revenue is the ceiling; new clients is the #1 lever (Apollo / LinkedIn / Meta).",
    `Scale Facebook — high margin (~${pct(facebook.profitBeforeCommission, fbRev || 1)}% before commission) and your real growth engine; add ad accounts.`,
    `Raise fees / expand the top 3 (${top3Pct}% of revenue) — small % increases drop straight to profit.`,
    `Cut ~$${Math.max(2000, softwareDragPerMo * 2).toLocaleString()}/mo of software to reclaim margin.`,
    "Productize delivery so contractor cost (~35% of revenue) scales sub-linearly with clients."
  ];

  return { hasData: true, latest, series, revenueTrendPct, netPeak: round(netPeak), netPeakLabel, netDeclinePct, marginNow, marginPeak, software: { first: swFirst, last: swLast, growthPct: swGrowthPct, topVendors, rising }, facebook, concentration: { top, top3Pct, totalMrr: round(totalMrr) }, projection, risks, scale };
}

const MONTHS3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function nextThree(label: string): string[] {
  const m = MONTHS3.findIndex((mm) => mm.toLowerCase() === label.slice(0, 3).toLowerCase());
  const ym = label.match(/(\d{2})/);
  let year = ym ? Number(ym[1]) : 26;
  if (m < 0) return ["Next 1", "Next 2", "Next 3"];
  const out: string[] = [];
  let idx = m;
  for (let i = 0; i < 3; i++) { idx++; if (idx > 11) { idx = 0; year++; } out.push(`${MONTHS3[idx]} '${String(year).padStart(2, "0")}`); }
  return out;
}
