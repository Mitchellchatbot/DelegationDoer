import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { Rocket } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner, OWNER_EMAIL } from "@/lib/access";
import { getStripeRevenue } from "@/lib/stripe";
import { listMemories } from "@/lib/brain-memory";
import { listAccounts, listThreads } from "@/lib/missive-client";
import { categorizeInbox } from "@/lib/owner-inbox";
import { GrowthBoard, type GrowthBrief } from "@/components/GrowthBoard";
import { getLatestGrowthBrief } from "@/lib/growth-brain";
import { MemoryEditor, type ScaleMemory } from "@/components/MemoryEditor";
import { InboxCopilot, type InboxThread } from "@/components/InboxCopilot";
import { ScaleAcquisition, ScaleAcquisitionLoading } from "@/components/ScaleAcquisition";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import { getOutboundSummary } from "@/lib/outbound-summary";
import { getScaleSources } from "@/lib/scale-sources";
import type { ScaleSourceFlags } from "@/lib/scale-sources-types";
import { ScaleSourceSwitches } from "@/components/ScaleSourceSwitches";
import { ScaleTabs } from "@/components/ScaleTabs";
import type { ParsedPnl } from "@/lib/pnl-parse";

export const dynamic = "force-dynamic";

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

// Owner-only command center — Mitchell + the brain in one place: the numbers,
// what to do to scale, the emails to reply to, and the priorities the brain
// optimizes toward. Same 404 gate as /finance.
export default async function ScalePage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  const supabase = getSupabaseAdmin();
  const [revenue, memories, mrrRes, finRes, growthBrief, sources] = await Promise.all([
    getStripeRevenue().catch(() => null),
    listMemories().catch(() => []),
    supabase.from("mrr_entries").select("company, mrr, status"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    getLatestGrowthBrief().catch(() => null),
    // Never throws; a failed read comes back as both off with the reason.
    getScaleSources()
  ]);
  const sourceFlags: ScaleSourceFlags = { facebook: sources.facebook, outbound: sources.outbound };

  // Snapshot: manual MRR (source of truth) + concentration + margin.
  const mrrRows = (mrrRes.data ?? []) as { company: string; mrr: number; status: string }[];
  const active = mrrRows.filter((r) => r.status === "active" || r.status === "paused");
  const mrr = active.reduce((s, r) => s + Number(r.mrr), 0);
  const top3 = [...active].sort((a, b) => Number(b.mrr) - Number(a.mrr)).slice(0, 3).reduce((s, r) => s + Number(r.mrr), 0);
  const top3Share = mrr ? Math.round((top3 / mrr) * 100) : 0;

  const parsed = ((finRes.data ?? []) as { parsed: ParsedPnl | null }[]).find((d) => d.parsed)?.parsed ?? null;
  let margin: number | null = null;
  if (parsed?.periods?.length) {
    const hasTotal = parsed.periods[parsed.periods.length - 1]?.toLowerCase() === "total";
    const months = hasTotal ? parsed.periods.slice(0, -1) : parsed.periods;
    const li = months.length - 1;
    const rev = parsed.summary.income[li] ?? null;
    const net = parsed.summary.net[li] ?? null;
    margin = rev && net != null ? Math.round((net / rev) * 100) : null;
  }
  const netNew = revenue ? revenue.newMrr - revenue.churnedMrr : null;

  const cards = [
    { label: "MRR", value: money(mrr), tone: "ink" as const },
    { label: "Net new · this mo", value: (netNew ?? 0) >= 0 ? `+${money(netNew)}` : money(netNew), tone: (netNew ?? 0) > 0 ? "emerald" : (netNew ?? 0) < 0 ? "rose" : "ink" as const },
    { label: "Margin", value: margin != null ? `${margin}%` : "—", tone: "ink" as const },
    { label: "Top-3 concentration", value: `${top3Share}%`, tone: top3Share >= 50 ? "amber" : "ink" as const }
  ];

  // Emails that actually need a reply.
  let threads: InboxThread[] = [];
  let inboxNote: string | null = null;
  try {
    const accounts = await listAccounts();
    const acct = accounts.find((a) => (a.email ?? "").toLowerCase() === OWNER_EMAIL);
    if (!acct) inboxNote = `No Missive inbox found for ${OWNER_EMAIL}.`;
    else {
      const raw = await listThreads({ mailboxId: acct.id, folder: "INBOX", status: "open", limit: 40 });
      const mapped = raw.map((t) => ({
        id: t.id,
        subject: t.subject || "(no subject)",
        from: t.last_from ?? (t.participants?.[0] ?? "unknown"),
        snippet: t.last_snippet ?? "",
        lastAt: t.last_message_at
      }));
      threads = await categorizeInbox(mapped);
      if (threads.length === 0) inboxNote = "Nothing needs sorting right now.";
    }
  } catch (err) {
    inboxNote = err instanceof Error ? err.message : "Inbox unavailable.";
  }

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
            You and your brain in one place: the numbers, what to do to scale, the emails to reply to, and what we&apos;re optimizing for. Just what needs you — nothing else.
          </p>
        </div>
      </div>

      {/* Overview (this page) · Outbound (the full pipeline + ad account) */}
      <ScaleTabs active="overview" />

      {/* Which outside apps the room (and the brain) reads */}
      <ScaleSourceSwitches initial={sources} />

      {/* Snapshot */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
            <div className="text-[11px] font-medium text-muted">{c.label}</div>
            <div className={"mt-1 text-2xl font-bold tabular-nums " + (c.tone === "emerald" ? "text-emerald-600" : c.tone === "rose" ? "text-rose-600" : c.tone === "amber" ? "text-amber-600" : "text-ink")}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      {/* Acquisition: the Facebook side from the Finance app and our own Outbound
          funnel from the ads dashboard. Streams in on its own, so a slow app
          never holds up the board or the emails below it. Only the sources
          switched on are fetched; with both off there's no section at all. */}
      {(sourceFlags.facebook || sourceFlags.outbound) && (
        <Suspense fallback={<ScaleAcquisitionLoading {...sourceFlags} />}>
          <ScaleAcquisitionSection sources={sourceFlags} />
        </Suspense>
      )}

      {/* The CEO board: constraint + Protect / Grow */}
      <GrowthBoard initial={growthBrief as GrowthBrief | null} currentSources={sourceFlags} />

      {/* Inbox — sorted by clients / potential clients / sales, reply-needed flagged */}
      <div>
        <div className="text-[13px] font-semibold text-ink mb-2 px-1">
          Inbox · sorted{threads.length ? ` (${threads.length})` : ""}
        </div>
        <InboxCopilot threads={threads} note={inboxNote} />
      </div>

      {/* Priorities / decisions */}
      <MemoryEditor initial={memories as ScaleMemory[]} />
    </div>
  );
}

// Only ever rendered below the owner gate above. Neither fetch throws. A source
// switched off is never called — not fetched and discarded, not called at all.
async function ScaleAcquisitionSection({ sources }: { sources: ScaleSourceFlags }) {
  const [revenue, outbound] = await Promise.all([
    sources.facebook ? getFacebookRevenue() : undefined,
    sources.outbound ? getOutboundSummary() : undefined
  ]);
  return <ScaleAcquisition revenue={revenue} outbound={outbound} />;
}
