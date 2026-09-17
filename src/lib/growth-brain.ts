import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getAllUsersLight } from "@/lib/server-data";
import { getClients } from "@/lib/clients-data";
import { getStripeRevenue } from "@/lib/stripe";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import { getOutboundBoard } from "@/lib/outbound-board";
import { getOutboundMeta } from "@/lib/outbound-meta";
import { getScaleSources } from "@/lib/scale-sources";
import { listMemories, formatMemoriesBlock } from "@/lib/brain-memory";
import { getBrainInstructions } from "@/lib/brain-instructions";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import type { Task } from "@/lib/types";
import type { FacebookRevenueResult } from "@/lib/facebook-revenue-types";
import type { OutboundSummaryResult } from "@/lib/outbound-summary-types";
import type { OutboundBoardResponse, OutboundBoardResult } from "@/lib/outbound-board-types";
import type { OutboundMetaResult } from "@/lib/outbound-meta-types";
import type { ScaleSourceFlags } from "@/lib/scale-sources-types";

// The Growth Brain: an aggressive-but-disciplined COO + Chief Growth Officer.
// It reads the whole business and answers one question — "what should we do next
// to make Scaled AI bigger, better, and more profitable?" — as a structured
// brief: the #1 growth constraint, things to PROTECT, and things to GROW
// (Scale Opportunities). Owner-only; callers gate with isOwner.

export interface GrowthConstraint {
  title: string;
  why: string;
  evidence: string;
  impact: string;
  solution: string;
  owner: string;
}
export interface ProtectItem {
  type: string; // clients-at-risk | performance | missed-commitment | bottleneck | margin-leak | capacity
  title: string;
  detail: string;
  severity: "high" | "medium";
  source?: string; // where this came from, e.g. "tl;dv call 2d ago" / "client health note" / "P&L"
}
export interface GrowItem {
  type: string; // expansion | upsell | sales-push | replicate-win | automation | delegation | hiring | experiment
  title: string;
  detail: string;
  estValue?: string; // e.g. "+$2,000/mo"
  action: string;
  owner?: string;
  confidence?: "high" | "medium" | "low";
  source?: string; // where this came from — see ProtectItem.source
}
export interface GrowthBrief {
  constraint: GrowthConstraint | null;
  protect: ProtectItem[];
  grow: GrowItem[];
  generatedAt: string;
  // Which outside sources were switched on when this brief was built. Absent on
  // briefs saved before the switches existed.
  sources?: ScaleSourceFlags;
  // Which core-rules version wrote it: a brain_instructions id, or "default"
  // when it ran on the hard-coded rules. Absent on briefs saved before the
  // rules became editable. Lets a bad brief be traced to an instructions edit.
  instructionsVersion?: string;
}

const money = (n: number | null | undefined) => (n == null ? "$0" : `$${Math.round(n).toLocaleString("en-US")}`);

const IN_FLIGHT = ["todo", "in_progress", "blocked", "review"];

// For the two sections below: signed, never null — a missing figure is spelled
// out in words there, because `money` above would print it as $0.
const usd = (n: number, digits = 0) => {
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
// Facebook-side revenue, as the Finance app computes it. Narrated, never
// recomputed, and never summed into MRR — the brain is told the same.
function facebookSideSection(fb: FacebookRevenueResult): string {
  const head = "## Facebook-side revenue (Finance app — a SEPARATE revenue stream from MRR; never add the two)";
  if (!fb.ok) return `${head}\nFacebook-side revenue unavailable: ${fb.error} (do NOT treat as $0)`;
  const d = fb.data;
  const c = d.current;
  const lines = [
    head,
    `${d.period}${d.provisional ? " (provisional — month still running, figures will change)" : ""}: Facebook-side revenue ${usd(c.revenue)} = management fees ${usd(c.managementFees)} + one-off/setup ${usd(c.oneOffRevenue)}, on ${usd(c.managedSpend)} of managed client Meta spend (${usd(c.feeBearingSpend)} of it fee-bearing).`,
    d.payers.length
      ? `Top payers: ${d.payers.slice(0, 5).map((p) => `${p.name} ${usd(p.revenue)} revenue on ${usd(p.managedSpend)} managed spend at ${p.closingRate === null ? "no rate" : `${(p.closingRate * 100).toFixed(0)}%`}`).join("; ")}.`
      : "No clients billing this month yet.",
    `Facebook-side revenue trend (oldest→newest): ${d.months.slice(-6).map((m) => `${m.period} ${usd(m.revenue)}`).join(", ")}.`
  ];
  return lines.join("\n");
}

// Our own acquisition funnel, as the Meta ads dashboard computes it: ad spend
// from Finance's ledger, the ad-form prospects it brought in, how many booked,
// and today's texting queues. Unknown is written as unknown, never as zero.
function outboundSection(ob: OutboundSummaryResult): string {
  const head = "## Outbound acquisition (our own Meta ads → Typeform prospects → booked calls)";
  if (!ob.ok) return `${head}\nOutbound data unavailable: ${ob.error} (do NOT treat as zero)`;
  const { ads, pipeline, queues } = ob.data;
  const lines = [head];
  const ratio = (n: number | null) => (n === null ? "—" : usd(n, 2));
  if (!ads.ok) {
    lines.push(`Ad spend unavailable: ${ads.error} (do NOT treat as zero)`);
  } else {
    if (!ads.months.length) {
      lines.push("No ad spend or ad-form prospects recorded yet.");
    } else {
      lines.push(`By month, newest first (spend = Finance's ledger for ${ads.accountLabel}; prospects = ad-form leads created that month; booked = those now at a booked stage):`);
    }
    for (const m of ads.months.slice(0, 4)) {
      const spend = m.spend === null
        ? `spend: no ledger row${m.beforeTracking ? " (before Finance tracked the account)" : ""}`
        : `spend ${usd(m.spend)}`;
      const estimate = m.isEstimate ? " (estimate, month still running: leads include today, spend stops at yesterday (UTC))" : "";
      const camps = m.campaigns.slice(0, 3).map((x) => `${x.campaignName} ${usd(x.spend)}`).join(", ");
      lines.push(`- ${m.period}: ${spend}${estimate} · ${m.prospects} prospects · ${m.booked} booked · ${ratio(m.costPerLead)}/lead · ${ratio(m.costPerBooked)}/booked${camps ? ` · top campaigns: ${camps}` : ""}`);
    }
    // A failed read matters most when it's why there are no months at all.
    if (ads.lastError) {
      lines.push(`Ad account sync: last read from Meta by Finance ${ads.lastSyncedAt ? `${ads.lastSyncedAt} UTC` : "never"}, and the last read FAILED: ${ads.lastError} — recent spend may be stale.`);
    }
    if (ads.campaignsError) lines.push(`Campaign split unavailable: ${ads.campaignsError} (the spend totals still stand).`);
  }
  lines.push(`Pipeline now (every outbound prospect at its current stage): ${pipeline.total} total · ${pipeline.booked} booked · ${pipeline.notBooked} not booked.`);
  lines.push(
    queues.reps.length
      ? `Texting queues today (leads each rep still has to text vs their daily cap): ${queues.reps.map((r) => `${r.owner} ${r.queued}/${r.dailyCap}`).join(", ")} (caps total ${queues.reps.reduce((s, r) => s + r.dailyCap, 0)}/day). Backlog: ${queues.backlog} queued leads not dealt to a rep yet — they wait for that daily capacity.`
      : `Backlog: ${queues.backlog} queued leads not dealt to a rep yet.`
  );
  return lines.join("\n");
}

// The LIVE outbound pipeline, lead by lead where it matters — the same board
// the reps work (Meta ads dashboard GET /api/outbound/board). Bounded: stage
// counts and ages for everyone, named facilities only for the leads a decision
// hangs on (booked / proposal / won, follow-ups, the newest arrivals). Contact
// people are left out; the facility and the rep are what the brain acts on.
const DAY_MS = 86_400_000;
type BoardLead = OutboundBoardResponse["prospects"][number];
function outboundPipelineSection(board: OutboundBoardResult, now: number): string {
  const head = "## Outbound pipeline — LIVE, lead by lead (the board the reps work today)";
  if (!board.ok) return `${head}\nLive pipeline unavailable: ${board.error} (do NOT treat as an empty pipeline)`;
  const b = board.data;
  const age = (iso: string | null) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS)) : null);
  const label = (k: string) => b.stages.find((s) => s.key === k)?.label ?? k;
  const isHot = (p: BoardLead) => p.stage === "booked" || p.stage === "proposal" || p.stage === "won";
  const lead = (p: BoardLead) => {
    const bits = [`${p.facility || p.name || "unnamed lead"}${p.location ? ` (${p.location})` : ""}`, label(p.stage)];
    if (p.owner) bits.push(`dealt to ${p.owner}`);
    if (p.source) bits.push(`source ${p.source}`);
    if (p.value != null && p.value > 0) bits.push(`budget ${usd(p.value)}/mo`);
    const a = age(p.createdAt);
    if (a != null) bits.push(`came in ${a}d ago`);
    if (p.lastContactedAt) bits.push(`last contacted ${p.lastContactedAt}${p.lastTextedBy ? ` by ${p.lastTextedBy}` : ""}`);
    if (p.followUp) bits.push(p.followUp === "needs" ? "NEEDS FOLLOW-UP" : "long-term follow-up");
    if (p.nextAction) bits.push(`next: ${p.nextAction.slice(0, 80)}${p.nextActionAt ? ` (due ${p.nextActionAt})` : ""}`);
    return `- ${bits.join(" · ")}`;
  };
  const lines = [head, `By stage: ${b.stages.map((s) => `${s.label} ${s.count}`).join(" · ")} (total ${b.pipeline.total}).`];

  const cold = b.prospects.filter((p) => p.stage === "new" || p.stage === "no_response");
  const buckets = [0, 0, 0, 0];
  for (const p of cold) {
    const a = age(p.createdAt);
    if (a == null) continue;
    buckets[a <= 7 ? 0 : a <= 14 ? 1 : a <= 30 ? 2 : 3]++;
  }
  lines.push(`Not yet reached (New + No response, ${cold.length}) by age since they came in: ≤7d ${buckets[0]} · 8–14d ${buckets[1]} · 15–30d ${buckets[2]} · >30d ${buckets[3]}. Reps' daily caps total ${b.queues.reps.reduce((n, r) => n + r.dailyCap, 0)}/day; backlog ${b.queues.backlog}.`);

  const bySource = new Map<string, { n: number; booked: number }>();
  for (const p of b.prospects) {
    const k = p.source || "(no source)";
    const e = bySource.get(k) ?? { n: 0, booked: 0 };
    e.n++;
    if (isHot(p)) e.booked++;
    bySource.set(k, e);
  }
  lines.push(`By source (leads → now booked or beyond): ${[...bySource.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 8).map(([k, v]) => `${k} ${v.n}→${v.booked}`).join(" · ")}.`);

  const within = (d: number) => b.prospects.filter((p) => { const a = age(p.createdAt); return a != null && a <= d; }).length;
  lines.push(`New leads: ${within(7)} in the last 7 days, ${within(30)} in the last 30.`);

  const hot = b.prospects.filter(isHot);
  if (hot.length) lines.push(`Booked / proposal / won (${hot.length}):`, ...hot.slice(0, 25).map(lead));
  const follow = b.prospects.filter((p) => p.followUp === "needs" && !isHot(p));
  if (follow.length) lines.push(`Flagged NEEDS FOLLOW-UP (${follow.length}):`, ...follow.slice(0, 15).map(lead));
  const newest = b.prospects.filter((p) => !isHot(p) && p.followUp !== "needs").slice(0, 8);
  if (newest.length) lines.push("Newest other leads:", ...newest.map(lead));
  return lines.join("\n");
}

// Our Meta ad account's live delivery over the last 7 full days vs the 7 before,
// read from Meta by the Meta ads dashboard (GET /api/outbound/meta) — the same
// numbers the Scale Room's Outbound tab shows.
function outboundMetaSection(meta: OutboundMetaResult): string {
  const head = "## Our Meta ads — LIVE delivery (last 7 full days vs the prior 7)";
  if (!meta.ok) return `${head}\nLive Meta read unavailable: ${meta.error} (do NOT treat as zero spend)`;
  const d = meta.data;
  const t = d.totals;
  const p = d.priorTotals;
  const n = (v: number | null, f: (x: number) => string) => (v == null ? "n/a" : f(v));
  const pc = (v: number) => `${v.toFixed(2)}%`;
  const lines = [
    head,
    `Window ${d.range.from}→${d.range.to} vs ${d.prior.from}→${d.prior.to}.`,
    `Spend ${usd(t.spend)} (prior ${usd(p.spend)}) · Meta leads ${t.leads} (prior ${p.leads}) · CPL ${n(t.cpl, (x) => usd(x, 2))} (prior ${n(p.cpl, (x) => usd(x, 2))}) · CTR ${n(t.ctr, pc)} (prior ${n(p.ctr, pc)}) · CPC ${n(t.cpc, (x) => usd(x, 2))} · CPM ${n(t.cpm, (x) => usd(x, 2))} · frequency ${n(t.frequency, (x) => x.toFixed(2))} · reach ${n(t.reach, (x) => Math.round(x).toLocaleString("en-US"))}.`,
    `Ad-form prospects created in the window: ${d.pipeline.prospects} (prior ${d.pipeline.priorProspects}); of those now booked: ${d.pipeline.booked} (prior ${d.pipeline.priorBooked}).`
  ];
  if (d.campaigns.length) {
    lines.push("Campaigns (spend · leads · CPL · CTR · status):", ...d.campaigns.slice(0, 6).map((c) => `- ${c.name}: ${usd(c.spend)} · ${c.leads} leads · ${n(c.cpl, (x) => usd(x, 2))} · ${n(c.ctr, pc)} · ${c.status ?? "status unknown"}`));
  }
  if (d.ads.length) {
    lines.push("Top ads by spend (spend · leads · CPL · CTR):", ...d.ads.slice(0, 6).map((a) => `- ${a.name} [${a.campaignName}]: ${usd(a.spend)} · ${a.leads} leads · ${n(a.cpl, (x) => usd(x, 2))} · ${n(a.ctr, pc)}`));
  }
  return lines.join("\n");
}

// The board carries everything the summary did (pipeline, queues, ad months),
// so the brief reads the board once and narrates the summary from it.
function summaryFromBoard(board: OutboundBoardResult): OutboundSummaryResult {
  if (!board.ok) return board;
  const { generatedAt, pipeline, queues, ads } = board.data;
  return { ok: true, data: { generatedAt, pipeline, queues, ads } };
}

// Assemble everything the Growth Brain reasons over into one snapshot string.
// The source switches are read once here and handed back, so the snapshot, the
// system prompt, and the brief's stamp all follow the same read.
// Exported so the agent connector can show the brain's exact input without
// paying for a model call. Owner-only data: callers gate with isOwner (or an
// owner-scoped agent key).
export async function getGrowthSnapshot(): Promise<{ text: string; sources: ScaleSourceFlags }> {
  const supabase = getSupabaseAdmin();
  // Never throws; a failed read is both off.
  const scale = await getScaleSources();
  const sources: ScaleSourceFlags = { facebook: scale.facebook, outbound: scale.outbound };
  const [revenue, clients, allTasks, roster, memories, mrrRes, finRes, swRes, payRes, cliMetaRes, mtgRes, fbRevenue, outboundBoard, outboundMeta] = await Promise.all([
    getStripeRevenue().catch(() => null),
    getClients().catch(() => []),
    getAllTasks().catch(() => [] as Task[]),
    getAllUsersLight().catch(() => []),
    listMemories().catch(() => []),
    supabase.from("mrr_entries").select("company, mrr, status"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    supabase.from("software_subscriptions").select("vendor, month, amount"),
    supabase.from("payroll_entries").select("name, role, status, scale, rate"),
    supabase.from("clients").select("id, updated_at, health_computed_at"),
    supabase
      .from("client_meetings")
      .select("client_id, meeting_date, title, brief")
      .gte("meeting_date", new Date(Date.now() - 21 * 86_400_000).toISOString())
      .order("meeting_date", { ascending: false })
      .limit(20),
    // Neither throws; a tighter bound than the pages use, so a slow app can't
    // eat the brief's time budget. A source switched off isn't called at all.
    sources.facebook ? getFacebookRevenue(20_000) : null,
    sources.outbound ? getOutboundBoard(20_000) : null,
    // Meta is read live on the other side (cached there a few minutes).
    sources.outbound ? getOutboundMeta(7, 45_000) : null
  ]);
  const outbound = outboundBoard ? summaryFromBoard(outboundBoard) : null;
  // Health notes carry their OWN computed date — a client row's updated_at moves
  // on any edit and is not when the health summary was scanned.
  const healthComputedAt = new Map<string, string | null>();
  for (const r of (cliMetaRes.data ?? []) as { id: string; updated_at: string; health_computed_at: string | null }[]) {
    healthComputedAt.set(r.id, r.health_computed_at ?? null);
  }
  const HEALTH_MAX_AGE_DAYS = 45; // older AI health guesses are dropped, not shown as current risk
  // Age of the health note in days, or null if there isn't a real computed date.
  const healthAgeDays = (id: string): number | null => {
    const h = healthComputedAt.get(id);
    if (!h) return null;
    return Math.round((Date.now() - Date.parse(h)) / 86_400_000);
  };
  const asOf = (days: number | null): string => (days == null ? "" : days <= 1 ? "today" : `${days}d ago`);

  // Revenue / MRR.
  const mrrRows = (mrrRes.data ?? []) as { company: string; mrr: number; status: string }[];
  const activeMrr = mrrRows.filter((r) => r.status === "active" || r.status === "paused");
  const mrr = activeMrr.reduce((s, r) => s + Number(r.mrr), 0);
  const top = [...activeMrr].sort((a, b) => Number(b.mrr) - Number(a.mrr)).slice(0, 8);
  const top3Share = mrr ? Math.round((top.slice(0, 3).reduce((s, r) => s + Number(r.mrr), 0) / mrr) * 100) : 0;

  // P&L margin / cost lines.
  const parsed = ((finRes.data ?? []) as { parsed: { periods: string[]; summary: { income: (number | null)[]; expenses: (number | null)[]; net: (number | null)[] }; expenseBreakdown: { account: string; total: number }[] } | null }[]).find((d) => d.parsed)?.parsed;
  let financeLine = "No P&L uploaded.";
  if (parsed?.periods?.length) {
    const hasTotal = parsed.periods[parsed.periods.length - 1]?.toLowerCase() === "total";
    const months = hasTotal ? parsed.periods.slice(0, -1) : parsed.periods;
    const li = months.length - 1;
    const rev = parsed.summary.income[li] ?? null;
    const net = parsed.summary.net[li] ?? null;
    const margin = rev && net != null ? Math.round((net / rev) * 100) : null;
    const cats = (parsed.expenseBreakdown ?? []).slice(0, 5).map((b) => `${b.account} ${money(b.total)}`).join(", ");
    financeLine = `P&L latest month (${months[li]}): revenue ${money(rev)}, net ${money(net)}${margin != null ? `, margin ${margin}%` : ""}. Biggest costs: ${cats}.`;
  }

  // Rising software vendors (margin leakage candidates).
  const sw = (swRes.data ?? []) as { vendor: string; month: string; amount: number }[];
  const byVendor = new Map<string, Record<string, number>>();
  for (const r of sw) { const v = byVendor.get(r.vendor) ?? {}; v[r.month] = (v[r.month] ?? 0) + Number(r.amount); byVendor.set(r.vendor, v); }
  const rising = [...byVendor.entries()]
    .map(([vendor, m]) => ({ vendor, aug: m["Aug"] ?? 0, jul: m["July"] ?? 0 }))
    .filter((v) => v.jul > 0 && v.aug / v.jul >= 1.25 && v.aug - v.jul > 100)
    .sort((a, b) => (b.aug - b.jul) - (a.aug - a.jul))
    .slice(0, 6)
    .map((v) => `${v.vendor} ${money(v.jul)}→${money(v.aug)}`);

  // Payroll / contractors by person — for margin, cost-per-head, and capacity.
  const pay = ((payRes.data ?? []) as { name: string; role: string | null; status: string; scale: string; rate: number }[])
    .map((p) => ({ name: p.name, role: p.role || "—", status: p.status, monthly: p.scale === "annual" ? Number(p.rate) / 12 : Number(p.rate) }));
  const activePay = pay.filter((p) => p.status === "active").sort((a, b) => b.monthly - a.monthly);
  const payrollMonthly = activePay.reduce((s, p) => s + p.monthly, 0);
  const ownerDraw = pay.filter((p) => p.status === "owner-draw").reduce((s, p) => s + p.monthly, 0);
  const payrollLine = activePay.length
    ? `Operating payroll/contractors: ${money(payrollMonthly)}/mo across ${activePay.length} active (excludes owner draw). By person: ${activePay.slice(0, 15).map((p) => `${p.name} (${p.role}) ${money(p.monthly)}`).join(", ")}. Payroll-to-MRR ratio: ${mrr ? Math.round((payrollMonthly / mrr) * 100) : "?"}%.${ownerDraw ? ` Owner draw (Mitchell, distribution of profit — not a business cost): ${money(ownerDraw)}/mo.` : ""}`
    : "No payroll data.";

  // Ops/automated noise that is NOT a business or client-sentiment signal —
  // stripped from health/notes so the brain doesn't treat a Wordfence email as
  // churn risk.
  const OPS_NOISE = /security alert|wordfence|vulnerabilit|malware|firewall|lockout|brute.?force|\bssl\b|\bplugin\b|backup (completed|failed)|sync (completed|failed)|update (completed|failed|available)|uptime|patch|automated (security|alert|notification)/i;
  const clean = (s: string | null): string => {
    if (!s) return "";
    // Drop sentences that are just automated-alert noise; keep real signal.
    const kept = s.split(/(?<=[.!?])\s+/).filter((sent) => sent.trim() && !OPS_NOISE.test(sent));
    return kept.join(" ").trim();
  };

  // Clients: name, priority, health, notes, MRR — with ops noise removed.
  const mrrByName = new Map<string, number>();
  for (const r of activeMrr) mrrByName.set(r.company.toLowerCase().replace(/[^a-z0-9]/g, ""), Number(r.mrr));
  const clientLines = clients.slice(0, 40).map((c) => {
    const key = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    let m = 0;
    for (const [k, v] of mrrByName) if (k && (k.includes(key) || key.includes(k))) { m = v; break; }
    const bits = [c.name];
    if (c.priority) bits.push(`priority:${c.priority}`);
    if (m) bits.push(`${money(m)}/mo`);
    const notes = clean(c.notes);
    // Only surface a health note that was actually computed recently — a stale
    // AI scan (Santa Barbara's was ~107d old) is not current risk.
    const hAge = healthAgeDays(c.id);
    const health = hAge != null && hAge <= HEALTH_MAX_AGE_DAYS ? clean(c.healthSummary) : "";
    if (health) bits.push(`health (as of ${asOf(hAge)}): ${health.slice(0, 140)}`);
    if (notes) bits.push(`notes: ${notes.slice(0, 140)}`);
    return `- ${bits.join(" · ")}`;
  }).join("\n");

  // Work by assignee — for capacity / bottleneck detection.
  const open = allTasks.filter((t) => IN_FLIGHT.includes(t.status));
  const nameById = new Map(roster.map((u) => [u.id, u.name]));
  const byAssignee = new Map<string, { count: number; overdue: number; tags: Map<string, number> }>();
  const now = Date.now();
  for (const t of open) {
    const who = t.assigneeId ? (nameById.get(t.assigneeId) ?? t.assigneeId) : "UNASSIGNED";
    const rec = byAssignee.get(who) ?? { count: 0, overdue: 0, tags: new Map() };
    rec.count += 1;
    if (t.dueDate && Date.parse(t.dueDate) < now) rec.overdue += 1;
    for (const tag of t.tags ?? []) rec.tags.set(tag, (rec.tags.get(tag) ?? 0) + 1);
    byAssignee.set(who, rec);
  }
  const loadLines = [...byAssignee.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([who, r]) => {
      const topTags = [...r.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t}×${n}`).join(", ");
      return `- ${who}: ${r.count} open${r.overdue ? `, ${r.overdue} overdue` : ""}${topTags ? ` (${topTags})` : ""}`;
    }).join("\n");

  // Recent wins (last 14 days) — replication candidates.
  const winCutoff = now - 14 * 86_400_000;
  const wins = allTasks
    .filter((t) => t.status === "done" && t.completedAt && Date.parse(t.completedAt) >= winCutoff)
    .slice(0, 15)
    .map((t) => `- "${t.title}"${t.clientName ? ` · ${t.clientName}` : ""}`)
    .join("\n");

  // Recent client calls (tl;dv) — the freshest, dated client voice.
  const nameByClientId = new Map(clients.map((c) => [c.id, c.name]));
  const meetingLines = ((mtgRes.data ?? []) as { client_id: string; meeting_date: string; title: string | null; brief: { risks?: string[]; clientRequests?: string[]; nextSteps?: string[]; keyDecisions?: string[] } | null }[])
    .map((mtg) => {
      const cname = nameByClientId.get(mtg.client_id) ?? "client";
      const days = Math.round((Date.now() - Date.parse(mtg.meeting_date)) / 86_400_000);
      const when = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
      const b = mtg.brief ?? {};
      const parts = [`- ${cname} — call ${when}${mtg.title ? ` (${mtg.title})` : ""}`];
      if (b.risks?.length) parts.push(`    risks: ${b.risks.slice(0, 2).join("; ")}`);
      if (b.clientRequests?.length) parts.push(`    they asked for: ${b.clientRequests.slice(0, 2).join("; ")}`);
      if (b.nextSteps?.length) parts.push(`    next steps: ${b.nextSteps.slice(0, 2).join("; ")}`);
      return parts.join("\n");
    }).join("\n");

  const text = [
    `## Revenue`,
    `MRR (source of truth): ${money(mrr)}/mo. Top clients: ${top.map((c) => `${c.company} ${money(c.mrr)}`).join(", ")}.`,
    `Concentration: top 3 = ${top3Share}% of MRR.`,
    revenue ? `Stripe: ${money(revenue.mrr)} MRR, net-new this month ${money(revenue.newMrr - revenue.churnedMrr)}.` : "Stripe unavailable (revenue-by-client / churn signals are off until the Stripe key is set in prod).",
    revenue && revenue.pastDue.length
      ? `CHURN RISK — PAST DUE (payment failing, protect these NOW): ${revenue.pastDue.map((p) => `${p.name} ${money(p.mrr)}/mo`).join("; ")}.`
      : "",
    revenue && revenue.churnedThisMonth.length
      ? `CHURNED this month (lost revenue — win back if possible): ${revenue.churnedThisMonth.map((c) => `${c.name} ${money(c.mrr)}/mo`).join("; ")}.`
      : "",
    ``,
    `## Finance`,
    financeLine,
    payrollLine,
    rising.length ? `Rising software spend (margin-leak candidates): ${rising.join(", ")}.` : "",
    ``,
    // A source switched off leaves no section — not even an "unavailable" line.
    ...(fbRevenue ? [facebookSideSection(fbRevenue), ``] : []),
    ...(outbound ? [outboundSection(outbound), ``] : []),
    ...(outboundBoard ? [outboundPipelineSection(outboundBoard, Date.now()), ``] : []),
    ...(outboundMeta ? [outboundMetaSection(outboundMeta), ``] : []),
    `## Clients (name · priority · MRR · health/notes)`,
    clientLines || "(none)",
    ``,
    `## Team load (open tasks by person — for capacity/bottleneck)`,
    loadLines || "(none)",
    ``,
    `## Recent client calls (tl;dv — the FRESHEST, dated client voice; a risk here outranks an old note, a request here is an expansion opening)`,
    meetingLines || "(no recent calls)",
    ``,
    `## Recent wins (last 14d — replication candidates)`,
    wins || "(none)",
    ``,
    memories.length ? `## Mitchell's standing priorities & decisions (weight everything toward these)\n${formatMemoriesBlock(memories)}` : ""
  ].filter(Boolean).join("\n");
  return { text, sources };
}

// The system prompt, in three parts:
//   1. `rules` — the mandate + core rules. Editable and versioned (see
//      brain-instructions.ts); DEFAULT_BRAIN_RULES is byte-identical to the
//      lines that used to be hard-coded here, so the default prompt is unchanged.
//   2. The Facebook-side and Outbound rules — there only when their source is
//      switched on (a rule about data the brain wasn't given would invite it to
//      reason about numbers it doesn't have). Kept in code: they must follow the
//      snapshot, not an edit.
//   3. The output contract — kept in code and always LAST, so no rules edit can
//      change the JSON shape generateGrowthBrief parses and /scale renders.
const growthSystem = (sources: ScaleSourceFlags, rules: string) => [
  rules,
  ...(sources.facebook ? ["- Facebook-side revenue (from the Finance app: management + setup fees on the client Meta spend we manage) is a SEPARATE stream from MRR. Never sum the two or double count a client across them. If it's unavailable, say so; never treat it as $0."] : []),
  ...(sources.outbound ? ["- Outbound spend / prospects / booked / cost per booked are our own acquisition funnel. When judging whether leads or sales is the constraint, use the cost-per-lead and cost-per-booked trend and the texting backlog vs the reps' daily caps as evidence. An estimate month is partial (leads include today, spend stops at yesterday) — never compare it to a full month as if it were complete.", "- The outbound pipeline and our Meta ads sections are LIVE. Use them lead by lead: name the booked/proposal facilities that need a push, the leads flagged NEEDS FOLLOW-UP, how stale the un-reached backlog is against the reps' daily capacity, which sources actually book, and — from the last 7 days of Meta delivery — whether CPL/CTR/frequency say the ads or the follow-up is the leak. When a lead is dealt to a rep, make that rep the owner.", "- CRITICAL: there are TWO SEPARATE pipelines, never conflate them or sum them. (1) COLD TEXTING pipeline: the ~300+ 'Treatment center list' leads the reps cold-text — high volume, ~0% book rate, its problem is throughput/backlog. (2) FACEBOOK BOOKED pipeline: 'Inbound form' + 'Typeform' leads from our Meta ads that convert to booked intro calls at a high rate — its problem is closing the booked calls. When you talk about backlog/texting capacity that's pipeline 1; when you talk about booked calls to close and cost-per-booked that's pipeline 2. Always say which pipeline an item is about."] : []),
  "- CHURN PROTECTION is the highest form of protecting clients: any client shown as PAST DUE (their Stripe payment is failing) is a top-severity PROTECT item — imminent revenue loss — name them and say to chase the payment today. A client who CHURNED this month is lost MRR: flag it and whether to win them back. If the Stripe line says it's unavailable, do NOT infer there's no churn — say the signal is off.",
  "",
  "PROVENANCE (required): every protect and grow item MUST include a \"source\" naming exactly where the claim comes from (which tl;dv call and how many days ago, which client health note, the P&L, the live pipeline, Meta delivery, etc.). If you cannot point to a source in the data below, do NOT include the item. Never state a specific fact (a cost-per-VOB, a missed report, a compliance risk) without its source.",
  "",
  "Return STRICT JSON only, no prose or code fences, with this exact shape:",
  "{",
  '  "constraint": { "title": string (the #1 thing currently stopping faster growth), "why": string, "evidence": string (cite real numbers/names), "impact": string (what removing it unlocks), "solution": string (concrete), "owner": string },',
  '  "protect": [ { "type": "clients-at-risk"|"performance"|"missed-commitment"|"bottleneck"|"margin-leak"|"capacity", "title": string, "detail": string (grounded in real data), "severity": "high"|"medium", "source": string (REQUIRED — where this came from, so Mitchell can trust it: e.g. "tl;dv call 2d ago", "client health note 13d ago", "P&L Aug", "live outbound pipeline", "Meta last 7d") } ],',
  '  "grow": [ { "type": "expansion"|"upsell"|"sales-push"|"replicate-win"|"automation"|"delegation"|"hiring"|"experiment", "title": string, "detail": string, "estValue": string (e.g. "+$2,000/mo" or "+2 accounts", omit if unknown), "action": string (the concrete next step), "owner": string, "confidence": "high"|"medium"|"low", "source": string (REQUIRED — where this came from, same as protect) } ]',
  "}",
  "Aim for 3-6 PROTECT items and 4-8 GROW items (Scale Opportunities), each most-impactful first. Only include items the data actually supports."
].join("\n");

// Generate a fresh Growth Brief, persist it, and return it.
export async function generateGrowthBrief(): Promise<GrowthBrief> {
  // The instructions read never throws: unreadable → default rules + readError,
  // so a missing table can't take the brief down. Read once, used once.
  const [{ text: snapshot, sources }, instructions] = await Promise.all([getGrowthSnapshot(), getBrainInstructions()]);
  if (instructions.readError) console.warn("[growth-brain] using default rules:", instructions.readError);
  const client = await getAnthropic();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await client.messages.create({
    model: MODELS.chat,
    max_tokens: 5000,
    system: growthSystem(sources, instructions.rules),
    messages: [{ role: "user", content: `Here is the current state of Scaled AI:\n\n${snapshot}\n\nGiven everything above, what should we do next to make the company bigger, better, and more profitable? Return the JSON brief.` }]
  });
  const text = (result.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
  // Robust extraction: strip fences, then take the outermost { ... } block.
  let raw = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  let json: { constraint?: GrowthConstraint | null; protect?: ProtectItem[]; grow?: GrowItem[] };
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`growth brief parse failed (stop=${result.stop_reason}, len=${text.length})`);
  }

  const brief: GrowthBrief = {
    constraint: json.constraint ?? null,
    protect: Array.isArray(json.protect) ? json.protect.slice(0, 8) : [],
    grow: Array.isArray(json.grow) ? json.grow.slice(0, 10) : [],
    generatedAt: new Date().toISOString(),
    // So /scale can tell when a source this brief used has since been switched off.
    sources,
    instructionsVersion: instructions.active?.id ?? "default"
  };

  const id = `gb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await getSupabaseAdmin().from("brain_growth").insert({ id, data: brief });
  return brief;
}

// Generating the brief takes 1-3 min (whole-business read + model call), which
// blows past the platform's request timeout — so a blocking POST 502s. Instead
// we kick generation off in the background (Railway runs a persistent process,
// so a non-awaited promise finishes after the response returns) and the client
// polls getLatestGrowthBrief until the timestamp advances.
let generating = false;
let lastRunError: string | null = null;

export function growthBriefStatus(): { generating: boolean; lastError: string | null } {
  return { generating, lastError: lastRunError };
}

// Start a background regeneration. Returns immediately. A no-op (started:false)
// if one is already running, so double-clicks don't stack model calls.
export function startGrowthBriefGeneration(): { started: boolean; alreadyRunning: boolean } {
  if (generating) return { started: false, alreadyRunning: true };
  generating = true;
  lastRunError = null;
  void generateGrowthBrief()
    .catch((e) => {
      lastRunError = e instanceof Error ? e.message : "generation failed";
      console.error("[growth] background generation failed:", lastRunError);
    })
    .finally(() => {
      generating = false;
    });
  return { started: true, alreadyRunning: false };
}

export async function getLatestGrowthBrief(): Promise<GrowthBrief | null> {
  const { data } = await getSupabaseAdmin()
    .from("brain_growth")
    .select("data, generated_at")
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.data) return null;
  return data.data as GrowthBrief;
}
