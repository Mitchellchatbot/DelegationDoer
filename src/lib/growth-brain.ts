import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getAllUsersLight } from "@/lib/server-data";
import { getClients } from "@/lib/clients-data";
import { getStripeRevenue } from "@/lib/stripe";
import { listMemories, formatMemoriesBlock } from "@/lib/brain-memory";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import type { Task } from "@/lib/types";

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

// Assemble everything the Growth Brain reasons over into one snapshot string.
async function assembleSnapshot(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [revenue, clients, allTasks, roster, memories, mrrRes, finRes, swRes, payRes] = await Promise.all([
    getStripeRevenue().catch(() => null),
    getClients().catch(() => []),
    getAllTasks().catch(() => [] as Task[]),
    getAllUsersLight().catch(() => []),
    listMemories().catch(() => []),
    supabase.from("mrr_entries").select("company, mrr, status"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    supabase.from("software_subscriptions").select("vendor, month, amount"),
    supabase.from("payroll_entries").select("name, role, status, scale, rate")
  ]);

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
  const payrollLine = activePay.length
    ? `Payroll/contractors: ${money(payrollMonthly)}/mo across ${activePay.length} active. By person: ${activePay.slice(0, 15).map((p) => `${p.name} (${p.role}) ${money(p.monthly)}`).join(", ")}. Payroll-to-MRR ratio: ${mrr ? Math.round((payrollMonthly / mrr) * 100) : "?"}%.`
    : "No payroll data.";

  // Clients: name, priority, health, notes, MRR.
  const mrrByName = new Map<string, number>();
  for (const r of activeMrr) mrrByName.set(r.company.toLowerCase().replace(/[^a-z0-9]/g, ""), Number(r.mrr));
  const clientLines = clients.slice(0, 40).map((c) => {
    const key = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    let m = 0;
    for (const [k, v] of mrrByName) if (k && (k.includes(key) || key.includes(k))) { m = v; break; }
    const bits = [c.name];
    if (c.priority) bits.push(`priority:${c.priority}`);
    if (m) bits.push(`${money(m)}/mo`);
    if (c.healthSummary) bits.push(`health: ${c.healthSummary.slice(0, 120)}`);
    if (c.notes) bits.push(`notes: ${c.notes.slice(0, 120)}`);
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
    `## Clients (name · priority · MRR · health/notes)`,
    clientLines || "(none)",
    ``,
    `## Team load (open tasks by person — for capacity/bottleneck)`,
    loadLines || "(none)",
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
    max_tokens: 3500,
    system: GROWTH_SYSTEM,
    messages: [{ role: "user", content: `Here is the current state of Scaled AI:\n\n${snapshot}\n\nGiven everything above, what should we do next to make the company bigger, better, and more profitable? Return the JSON brief.` }]
  });
  const text = (result.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
  const json = JSON.parse(text.replace(/^```json?\s*/i, "").replace(/```$/, "").trim());

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
