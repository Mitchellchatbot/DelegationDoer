import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getAllUsersLight } from "@/lib/server-data";
import { getClients } from "@/lib/clients-data";
import { getStripeRevenue } from "@/lib/stripe";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import { getOutboundSummary } from "@/lib/outbound-summary";
import { listMemories, formatMemoriesBlock } from "@/lib/brain-memory";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import type { Task } from "@/lib/types";
import type { FacebookRevenueResult } from "@/lib/facebook-revenue-types";
import type { OutboundSummaryResult } from "@/lib/outbound-summary-types";

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
}
export interface GrowItem {
  type: string; // expansion | upsell | sales-push | replicate-win | automation | delegation | hiring | experiment
  title: string;
  detail: string;
  estValue?: string; // e.g. "+$2,000/mo"
  action: string;
  owner?: string;
  confidence?: "high" | "medium" | "low";
}
export interface GrowthBrief {
  constraint: GrowthConstraint | null;
  protect: ProtectItem[];
  grow: GrowItem[];
  generatedAt: string;
}

const money = (n: number | null | undefined) => (n == null ? "$0" : `$${Math.round(n).toLocaleString("en-US")}`);

const IN_FLIGHT = ["todo", "in_progress", "blocked", "review"];

// For the two sections below: signed, never null — a missing figure is spelled
// out in words there, because `money` above would print it as $0.
const usd = (n: number, digits = 0) => {
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
// The Finance app's percents are PERCENT already (18.7 = 18.7%).
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

// Facebook-side revenue, as the Finance app computes it. Narrated, never
// recomputed, and never summed into MRR — the brain is told the same. Its net
// and margin are the Facebook side's only, not the uploaded QuickBooks P&L's
// under ## Finance.
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
  const p = d.pnl;
  if (!p) {
    lines.push("Facebook-side costs/margin: not sent by the Finance app (unknown — not $0).");
  } else if (p.noExpensesRecorded) {
    lines.push(`Facebook-side P&L: NO expenses entered in the Finance app for ${d.period} yet, so there is no real Facebook-side net profit or margin (do NOT read as $0 costs). Top-payer concentration ${pct(p.concentrationPct)} of Facebook-side revenue.`);
  } else {
    lines.push(`Facebook-side P&L: expenses ${usd(p.expensesTotal)} (${p.expenseLines} ledger lines), Facebook-side net profit ${usd(p.netProfit)}, Facebook-side net margin ${pct(p.netMarginPct)}, software ${usd(p.softwareCosts)} (${pct(p.softwarePctOfRevenue)} of revenue), top-payer concentration ${pct(p.concentrationPct)} of Facebook-side revenue.${d.provisional ? " Costs are still arriving for this month (they land whole and are still being entered), so treat the net and margin as incomplete." : ""}`);
  }
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
  } else if (!ads.months.length) {
    lines.push("No ad spend or ad-form prospects recorded yet.");
  } else {
    lines.push(`By month, newest first (spend = Finance's ledger for ${ads.accountLabel}; prospects = ad-form leads created that month; booked = those now at a booked stage):`);
    for (const m of ads.months.slice(0, 4)) {
      const spend = m.spend === null
        ? `spend: no ledger row${m.beforeTracking ? " (before Finance tracked the account)" : ""}`
        : `spend ${usd(m.spend)}`;
      const estimate = m.isEstimate ? " (estimate, month still running: leads include today, spend stops at yesterday (UTC))" : "";
      const camps = m.campaigns.slice(0, 3).map((x) => `${x.campaignName} ${usd(x.spend)}`).join(", ");
      lines.push(`- ${m.period}: ${spend}${estimate} · ${m.prospects} prospects · ${m.booked} booked · ${ratio(m.costPerLead)}/lead · ${ratio(m.costPerBooked)}/booked${camps ? ` · top campaigns: ${camps}` : ""}`);
    }
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

// Assemble everything the Growth Brain reasons over into one snapshot string.
async function assembleSnapshot(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [revenue, clients, allTasks, roster, memories, mrrRes, finRes, swRes, payRes, cliMetaRes, mtgRes, fbRevenue, outbound] = await Promise.all([
    getStripeRevenue().catch(() => null),
    getClients().catch(() => []),
    getAllTasks().catch(() => [] as Task[]),
    getAllUsersLight().catch(() => []),
    listMemories().catch(() => []),
    supabase.from("mrr_entries").select("company, mrr, status"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    supabase.from("software_subscriptions").select("vendor, month, amount"),
    supabase.from("payroll_entries").select("name, role, status, scale, rate"),
    supabase.from("clients").select("id, updated_at"),
    supabase
      .from("client_meetings")
      .select("client_id, meeting_date, title, brief")
      .gte("meeting_date", new Date(Date.now() - 21 * 86_400_000).toISOString())
      .order("meeting_date", { ascending: false })
      .limit(20),
    // Neither throws; a tighter bound than the pages use, so a slow app can't
    // eat the brief's time budget.
    getFacebookRevenue(20_000),
    getOutboundSummary(20_000)
  ]);
  const clientUpdatedAt = new Map<string, string>();
  for (const r of (cliMetaRes.data ?? []) as { id: string; updated_at: string }[]) clientUpdatedAt.set(r.id, r.updated_at);
  const asOf = (id: string): string => {
    const u = clientUpdatedAt.get(id);
    if (!u) return "";
    const days = Math.round((Date.now() - Date.parse(u)) / 86_400_000);
    return days <= 1 ? "today" : `${days}d ago`;
  };

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
    const health = clean(c.healthSummary);
    const notes = clean(c.notes);
    const stamp = asOf(c.id);
    if (health) bits.push(`health${stamp ? ` (as of ${stamp})` : ""}: ${health.slice(0, 140)}`);
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

  return [
    `## Revenue`,
    `MRR (source of truth): ${money(mrr)}/mo. Top clients: ${top.map((c) => `${c.company} ${money(c.mrr)}`).join(", ")}.`,
    `Concentration: top 3 = ${top3Share}% of MRR.`,
    revenue ? `Stripe: ${money(revenue.mrr)} MRR, net-new this month ${money(revenue.newMrr - revenue.churnedMrr)}, past-due ${money(revenue.pastDueMrr)} (${revenue.pastDue.length}).` : "Stripe unavailable.",
    ``,
    `## Finance`,
    financeLine,
    payrollLine,
    rising.length ? `Rising software spend (margin-leak candidates): ${rising.join(", ")}.` : "",
    ``,
    facebookSideSection(fbRevenue),
    ``,
    outboundSection(outbound),
    ``,
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
}

const GROWTH_SYSTEM = [
  "You are the AI Brain for Scaled AI, a digital agency for addiction-treatment / behavioral-health clients. You operate like an aggressive but disciplined COO + Chief Growth Officer for the founder, Mitchell.",
  "",
  "Your mandate has two sides, always active at once:",
  "1) PROTECT the business: prevent churn, missed deadlines, poor performance, wasted spend, dropped leads, communication gaps, bottlenecks, margin leakage, and capacity failures.",
  "2) PUSH the business: constantly find where Scaled AI can acquire more customers, expand existing accounts, increase capacity, improve margins, replicate wins, and move faster.",
  "",
  "Core rules:",
  "- Do NOT confuse stability with success. Healthy operations are the foundation for growth, not the goal. When something works, ask: how do we scale, replicate, automate, delegate, productize, or monetize it?",
  "- Hunt the constraint. Growth is limited by the single biggest current bottleneck (leads, sales, delivery capacity, onboarding, account management, cash). Identify the #1 constraint right now with evidence and the impact of removing it.",
  "- Turn isolated wins into systems. When something performs unusually well, investigate WHY and whether it's repeatable across clients/departments.",
  "- Think in outcomes, not activity. Not 'X sent 5 texts' — think funnel and throughput, and how to increase it without losing quality.",
  "- Controlled aggression: push hard when evidence shows capacity to scale, but protect quality, client outcomes, cash flow, and margins. Never recommend growth merely for activity's sake.",
  "- Be specific and grounded in the real data below: name clients, people, numbers, dollar estimates, and owners. No vague themes.",
  "- IGNORE automated system noise. Security/Wordfence/plugin/vulnerability/backup/uptime/SSL alerts are ops noise, NOT churn signals or client sentiment — never surface them as risks. A client is only 'at risk' when there's a REAL human signal: a person expressed frustration/dissatisfaction, an unmet request or broken promise, a payment/past-due problem, or explicit churn intent.",
  "- Do NOT surface internal team task-status ('X has 3 overdue tasks', 'stuck with the team') as a PROTECT item on its own. Team load only matters as a capacity constraint or when it's directly causing a client-facing failure a human has reacted to.",
  "- Weigh recency. Client health/notes carry an 'as of Nd ago' stamp, and recent client calls (tl;dv) are dated — LEAD with the freshest signals. A risk raised on a call this week outranks a 2-week-old note; a request made on a call is a live expansion opening (turn it into a GROW item). When you flag a client risk, state how recent it is, and discount anything older than ~3 weeks unless corroborated.",
  "- Facebook-side revenue (from the Finance app: management + setup fees on the client Meta spend we manage) is a SEPARATE stream from MRR. Never sum the two or double count a client across them. Its Facebook-side net profit and margin are that stream only — never confuse them with the uploaded QuickBooks P&L's margin under ## Finance. If it's unavailable, say so; never treat it as $0.",
  "- Outbound spend / prospects / booked / cost per booked are our own acquisition funnel. When judging whether leads or sales is the constraint, use the cost-per-lead and cost-per-booked trend and the texting backlog vs the reps' daily caps as evidence. An estimate month is partial (leads include today, spend stops at yesterday) — never compare it to a full month as if it were complete.",
  "",
  "Return STRICT JSON only, no prose or code fences, with this exact shape:",
  "{",
  '  "constraint": { "title": string (the #1 thing currently stopping faster growth), "why": string, "evidence": string (cite real numbers/names), "impact": string (what removing it unlocks), "solution": string (concrete), "owner": string },',
  '  "protect": [ { "type": "clients-at-risk"|"performance"|"missed-commitment"|"bottleneck"|"margin-leak"|"capacity", "title": string, "detail": string (grounded in real data), "severity": "high"|"medium" } ],',
  '  "grow": [ { "type": "expansion"|"upsell"|"sales-push"|"replicate-win"|"automation"|"delegation"|"hiring"|"experiment", "title": string, "detail": string, "estValue": string (e.g. "+$2,000/mo" or "+2 accounts", omit if unknown), "action": string (the concrete next step), "owner": string, "confidence": "high"|"medium"|"low" } ]',
  "}",
  "Aim for 3-6 PROTECT items and 4-8 GROW items (Scale Opportunities), each most-impactful first. Only include items the data actually supports."
].join("\n");

// Generate a fresh Growth Brief, persist it, and return it.
export async function generateGrowthBrief(): Promise<GrowthBrief> {
  const snapshot = await assembleSnapshot();
  const client = await getAnthropic();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await client.messages.create({
    model: MODELS.chat,
    max_tokens: 5000,
    system: GROWTH_SYSTEM,
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
    generatedAt: new Date().toISOString()
  };

  const id = `gb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await getSupabaseAdmin().from("brain_growth").insert({ id, data: brief });
  return brief;
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
