// Server-side CFO snapshot: loads the same finance data the /finance page uses
// and runs the survival (defense) + learnings models. Used by the daily briefing
// so the morning brief carries the same CFO read Mitchell sees on the page.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { computeDefense, type Defense } from "@/lib/finance-defense";
import { computeLearnings, type Learnings, type PnlMonth, type SoftwareItem } from "@/lib/finance-learnings";

export interface CfoSnapshot { defense: Defense; learnings: Learnings }

export async function loadCfoSnapshot(): Promise<CfoSnapshot | null> {
  const supabase = getSupabaseAdmin();
  const [mrrRes, swRes, fbMonthRes, pnlRes, pnlLinesRes, deelRes] = await Promise.all([
    supabase.from("mrr_entries").select("company, mrr"),
    supabase.from("software_subscriptions").select("vendor, month, amount, segment"),
    supabase.from("facebook_monthly").select("period, revenue, expenses"),
    supabase.from("pnl_monthly").select("period, label, income, expenses, net, taxes, writeoffs, software, contractors, advertising").order("period", { ascending: true }),
    supabase.from("pnl_lines").select("period, account, amount"),
    supabase.from("deel_payments").select("period, contractor, amount, is_fee")
  ]);

  const pnlMonths: PnlMonth[] = ((pnlRes.data ?? []) as Record<string, unknown>[]).map((m) => ({
    period: String(m.period), label: String(m.label),
    income: Number(m.income), expenses: Number(m.expenses), net: Number(m.net),
    taxes: Number(m.taxes), writeoffs: Number(m.writeoffs),
    software: Number(m.software), contractors: Number(m.contractors), advertising: Number(m.advertising)
  }));
  if (pnlMonths.length === 0) return null;

  const softwareItems: SoftwareItem[] = ((swRes.data ?? []) as Record<string, unknown>[]).map((s) => ({
    vendor: String(s.vendor), month: String(s.month), amount: Number(s.amount), segment: (s.segment ?? "seo") as string
  }));

  const fbRevenueByPeriod: Record<string, number> = {};
  const fbExpensesByPeriod: Record<string, number> = {};
  for (const r of (fbMonthRes.data ?? []) as { period: string; revenue: number; expenses: number }[]) {
    fbRevenueByPeriod[r.period] = Number(r.revenue);
    if (r.expenses != null) fbExpensesByPeriod[r.period] = Number(r.expenses);
  }

  const mrrClients = ((mrrRes.data ?? []) as { company: string; mrr: number }[])
    .map((r) => ({ company: String(r.company ?? ""), mrr: Number(r.mrr) || 0 }));

  const learnings = computeLearnings({ pnl: pnlMonths, fbRevenueByPeriod, fbExpensesByPeriod, softwareItems, mrrClients });

  const bookLines = ((pnlLinesRes.data ?? []) as { period: string; account: string; amount: number }[])
    .map((l) => ({ period: String(l.period), account: String(l.account), amount: Number(l.amount) }));
  const deelRows = ((deelRes.data ?? []) as { period: string; contractor: string; amount: number; is_fee: boolean }[])
    .map((r) => ({ period: String(r.period), contractor: String(r.contractor), amount: Number(r.amount), is_fee: !!r.is_fee }));

  const latestPnl = pnlMonths[pnlMonths.length - 1];
  const defense = computeDefense({
    month: latestPnl.label,
    revenue: latestPnl.income,
    normalizedNet: latestPnl.net + latestPnl.taxes + latestPnl.writeoffs,
    founderPay: bookLines.filter((l) => l.period === latestPnl.period && l.account.toLowerCase().includes("mitchell price")).reduce((s, l) => s + l.amount, 0),
    software: latestPnl.software,
    ads: latestPnl.advertising,
    contractors: deelRows.filter((r) => r.period === latestPnl.period && !r.is_fee).map((r) => ({ name: r.contractor, monthly: r.amount })),
    topClients: mrrClients.filter((c) => c.mrr > 0).sort((a, b) => b.mrr - a.mrr)
  });

  return { defense, learnings };
}

// A compact plain-text CFO read for the morning brief — the same survival status
// + moves as the on-page CFO read, as data the drafting model folds in.
export function cfoReadBlock(snap: CfoSnapshot): string {
  const { defense: d, learnings: l } = snap;
  if (!d.hasData && !l.hasData) return "";
  const m = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
  const lines: string[] = [];
  if (d.hasData) {
    lines.push(d.onTrack
      ? `Survival margin (before founder pay): ${d.marginPct}% — ABOVE the ${d.floorPct}% floor (${d.month}).`
      : `Survival margin (before founder pay): ${d.marginPct}% — BELOW the ${d.floorPct}% floor by ${m(d.gapNow)}/mo (${d.month}). This is the survival rule; closing this gap is priority one.`);
    const worst = d.scenarios[0];
    if (worst) lines.push(`Client-loss exposure: losing ${worst.client.split(",")[0]} (−${m(worst.lostMrr)}/mo) drops margin to ${worst.newMarginPct}%${worst.cutNeeded > 0 ? `, needing ${m(worst.cutNeeded)}/mo of cuts to hold ${d.floorPct}%` : ""}.`);
    lines.push(`Defense pool available if needed: ${m(d.cutCapacity)}/mo (software, ads, non-protected roles). Protected (never cut): ${d.protected.map((p) => p.name).join(", ") || "none"}.`);
  }
  if (l.hasData && l.verdict) lines.push(`The read: ${l.verdict}`);
  return lines.join("\n");
}
