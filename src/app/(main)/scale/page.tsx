import { notFound, redirect } from "next/navigation";
import { Rocket } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner } from "@/lib/access";
import { getStripeRevenue } from "@/lib/stripe";
import { listMemories } from "@/lib/brain-memory";
import { ScaleRoom, type ScaleMove } from "@/components/ScaleRoom";
import type { ParsedPnl } from "@/lib/pnl-parse";

export const dynamic = "force-dynamic";

// Owner-only Scale Room — Mitchell's private strategic cockpit. Same 404 gate
// as /finance: anyone who isn't Mitchell can't even see it exists.
export default async function ScalePage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  const supabase = getSupabaseAdmin();
  const [revenue, memories, mrrRes, finRes, movesRes] = await Promise.all([
    getStripeRevenue().catch(() => null),
    listMemories().catch(() => []),
    supabase.from("mrr_entries").select("company, mrr, status"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    supabase.from("brain_moves").select("moves, headline, generated_at").order("generated_at", { ascending: false }).limit(1).maybeSingle()
  ]);

  // Manual MRR (source of truth) + concentration.
  const mrrRows = (mrrRes.data ?? []) as { company: string; mrr: number; status: string }[];
  const active = mrrRows.filter((r) => r.status === "active" || r.status === "paused");
  const mrr = active.reduce((s, r) => s + Number(r.mrr), 0);
  const top3 = [...active].sort((a, b) => Number(b.mrr) - Number(a.mrr)).slice(0, 3).reduce((s, r) => s + Number(r.mrr), 0);
  const top3Share = mrr ? Math.round((top3 / mrr) * 100) : 0;

  // Margin from latest P&L.
  const parsed = ((finRes.data ?? []) as { parsed: ParsedPnl | null }[]).find((d) => d.parsed)?.parsed ?? null;
  let margin: number | null = null;
  let burn: number | null = null;
  if (parsed?.periods?.length) {
    const hasTotal = parsed.periods[parsed.periods.length - 1]?.toLowerCase() === "total";
    const months = hasTotal ? parsed.periods.slice(0, -1) : parsed.periods;
    const li = months.length - 1;
    const rev = parsed.summary.income[li] ?? null;
    const net = parsed.summary.net[li] ?? null;
    burn = parsed.summary.expenses[li] ?? null;
    margin = rev && net != null ? Math.round((net / rev) * 100) : null;
  }

  const snapshot = {
    mrr,
    netNew: revenue ? revenue.newMrr - revenue.churnedMrr : null,
    margin,
    top3Share,
    burn
  };

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-2xl bg-indigo-100 text-indigo-700 grid place-items-center shrink-0">
          <Rocket className="w-5 h-5" />
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Private · you only</div>
          <h1 className="text-2xl font-bold text-ink leading-tight">Scale Room</h1>
          <p className="text-sm text-muted mt-0.5 max-w-prose">
            You and your brain, working the growth problem together. The numbers that matter, what we&apos;re optimizing for, and the highest-leverage moves — in one place only you can see.
          </p>
        </div>
      </div>

      <ScaleRoom
        snapshot={snapshot}
        initialMemories={memories}
        initialMoves={(movesRes.data?.moves as ScaleMove[]) ?? []}
        initialHeadline={movesRes.data?.headline ?? null}
        initialGeneratedAt={movesRes.data?.generated_at ?? null}
      />
    </div>
  );
}
