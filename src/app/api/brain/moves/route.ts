import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllTasks } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { getStripeRevenue } from "@/lib/stripe";
import { listMemories, formatMemoriesBlock } from "@/lib/brain-memory";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Move {
  title: string;
  why: string;
  priority: "high" | "medium";
}

async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

// GET — return the latest persisted set of moves (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const { data } = await getSupabaseAdmin()
    .from("brain_moves")
    .select("moves, headline, generated_at")
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({
    headline: data?.headline ?? null,
    moves: (data?.moves as Move[]) ?? [],
    generatedAt: data?.generated_at ?? null
  });
}

const money = (n: number | null | undefined) => (n == null ? "$0" : `$${Math.round(n).toLocaleString("en-US")}`);

// POST — generate a fresh set of scale moves grounded in the whole business,
// persist it, and return it (owner only).
export async function POST() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const supabase = getSupabaseAdmin();
  const [revenue, memories, allTasks, mrrRes, finRes] = await Promise.all([
    getStripeRevenue().catch(() => null),
    listMemories().catch(() => []),
    getAllTasks().catch(() => []),
    supabase.from("mrr_entries").select("company, mrr, status"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5)
  ]);

  // Manual MRR (source of truth).
  const mrrRows = (mrrRes.data ?? []) as { company: string; mrr: number; status: string }[];
  const manualMrr = mrrRows.filter((r) => r.status === "active" || r.status === "paused").reduce((s, r) => s + Number(r.mrr), 0);
  const topClients = mrrRows
    .filter((r) => r.status === "active" || r.status === "paused")
    .sort((a, b) => Number(b.mrr) - Number(a.mrr))
    .slice(0, 5);
  const top3Share = manualMrr ? Math.round((topClients.slice(0, 3).reduce((s, r) => s + Number(r.mrr), 0) / manualMrr) * 100) : 0;

  // Expenses (latest P&L).
  const parsed = ((finRes.data ?? []) as { parsed: { periods: string[]; summary: { income: (number | null)[]; expenses: (number | null)[]; net: (number | null)[] }; expenseBreakdown: { account: string; total: number }[] } | null }[])
    .find((d) => d.parsed)?.parsed;
  let expenseLine = "No P&L uploaded.";
  if (parsed?.periods?.length) {
    const hasTotal = parsed.periods[parsed.periods.length - 1]?.toLowerCase() === "total";
    const months = hasTotal ? parsed.periods.slice(0, -1) : parsed.periods;
    const li = months.length - 1;
    const rev = parsed.summary.income[li] ?? null;
    const exp = parsed.summary.expenses[li] ?? null;
    const net = parsed.summary.net[li] ?? null;
    const margin = rev && net != null ? Math.round((net / rev) * 100) : null;
    const top = (parsed.expenseBreakdown ?? []).slice(0, 5).map((b) => `${b.account} ${money(b.total)}`).join(", ");
    expenseLine = `Latest month (${months[li]}): expenses ${money(exp)}, net ${money(net)}${margin != null ? `, margin ${margin}%` : ""}. Biggest cost categories: ${top}.`;
  }

  // Work snapshot.
  const IN_FLIGHT = ["todo", "in_progress", "blocked", "review"];
  const open = allTasks.filter((t) => IN_FLIGHT.includes(t.status));
  const criticalUnassigned = open.filter((t) => t.priority === "critical" && !t.assigneeId).length;

  const snapshot = [
    `MRR (manual, source of truth): ${money(manualMrr)}/mo · ${topClients.length ? `top clients: ${topClients.map((c) => `${c.company} ${money(c.mrr)}`).join(", ")}` : ""}`,
    `Revenue concentration: top 3 clients = ${top3Share}% of MRR.`,
    revenue ? `Stripe: ${money(revenue.mrr)} MRR, net-new this month ${money(revenue.newMrr - revenue.churnedMrr)}, past-due ${money(revenue.pastDueMrr)} (${revenue.pastDue.length} accounts).` : "Stripe unavailable.",
    expenseLine,
    `Work: ${open.length} in-flight tasks, ${criticalUnassigned} critical + unassigned.`,
    memories.length ? `\nStanding priorities & decisions (weight moves HEAVILY toward these):\n${formatMemoriesBlock(memories)}` : ""
  ].join("\n");

  const system =
    "You are the strategic co-founder / chief of staff to Mitchell, founder of Scaled AI (a digital agency serving addiction-treatment / behavioral-health clients). Your shared goal is to SCALE the company together. Given the business snapshot, return concrete, prioritized moves — decisions and actions Mitchell should make to grow, cut, and scale. Be specific and grounded in the real numbers (name clients, channels, costs, people, and target figures). No vague themes. Weight heavily toward his standing priorities. " +
    'Return STRICT JSON only: { "headline": string (one punchy sentence on the single most important focus right now), "moves": [ { "title": string (the move, imperative), "why": string (1-2 sentences, grounded in a real number), "priority": "high" | "medium" } ] } with 4-6 moves, most impactful first.';

  let out: { headline: string; moves: Move[] };
  try {
    const client = await getAnthropic();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await client.messages.create({
      model: MODELS.chat,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: `Business snapshot:\n\n${snapshot}\n\nGive me the moves.` }]
    });
    const text = (result.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
    const json = text.replace(/^```json?\s*/i, "").replace(/```$/, "").trim();
    out = JSON.parse(json);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "generation failed" }, { status: 500 });
  }

  const moves = Array.isArray(out.moves) ? out.moves.slice(0, 8) : [];
  const id = `mv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from("brain_moves").insert({ id, moves, headline: out.headline ?? null });

  return NextResponse.json({ headline: out.headline ?? null, moves, generatedAt: new Date().toISOString() });
}
