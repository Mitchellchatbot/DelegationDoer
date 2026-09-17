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
import { ActNowTabs } from "@/components/ActNowTabs";
import { getReachOutClients, getReactivatePitches, getFollowUpLeads } from "@/lib/scale-actions";
import { type InboxThread } from "@/components/InboxCopilot";
import { ScaleAcquisition, ScaleAcquisitionLoading } from "@/components/ScaleAcquisition";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import { getOutboundSummary } from "@/lib/outbound-summary";
import { getOutboundMeta } from "@/lib/outbound-meta";
import type { ScaleSourceFlags } from "@/lib/scale-sources-types";
import { ScaleChat } from "@/components/ScaleChat";
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
  const [revenue, memories, mrrRes, finRes, growthBrief] = await Promise.all([
    getStripeRevenue().catch(() => null),
    listMemories().catch(() => []),
    supabase.from("mrr_entries").select("company, mrr, status"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    getLatestGrowthBrief().catch(() => null)
  ]);
  // The room always reads both acquisition sources — Facebook (booked calls)
  // and the outbound pipeline. No toggles: Mitchell wants both, always.
  const sourceFlags: ScaleSourceFlags = { facebook: true, outbound: true };

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

  // Colored metric tiles — each hue is a full class string so Tailwind's JIT
  // keeps them. Net-new flips green/red on sign; concentration flips amber when
  // it's a risk.
  const HUE: Record<string, { card: string; label: string; value: string }> = {
    indigo: { card: "bg-indigo-50 border-indigo-100", label: "text-indigo-600", value: "text-indigo-700" },
    emerald: { card: "bg-emerald-50 border-emerald-100", label: "text-emerald-600", value: "text-emerald-700" },
    rose: { card: "bg-rose-50 border-rose-100", label: "text-rose-600", value: "text-rose-700" },
    violet: { card: "bg-violet-50 border-violet-100", label: "text-violet-600", value: "text-violet-700" },
    amber: { card: "bg-amber-50 border-amber-100", label: "text-amber-600", value: "text-amber-700" },
    sky: { card: "bg-sky-50 border-sky-100", label: "text-sky-600", value: "text-sky-700" }
  };
  const cards = [
    { label: "MRR", value: money(mrr), hue: "indigo" },
    { label: "Net new · this mo", value: (netNew ?? 0) >= 0 ? `+${money(netNew)}` : money(netNew), hue: (netNew ?? 0) < 0 ? "rose" : "emerald" },
    { label: "Margin", value: margin != null ? `${margin}%` : "—", hue: "violet" },
    { label: "Top-3 concentration", value: `${top3Share}%`, hue: top3Share >= 50 ? "amber" : "sky" }
  ];

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white grid place-items-center shrink-0 shadow-soft">
          <Rocket className="w-4.5 h-4.5" />
        </div>
        <h1 className="text-2xl font-bold text-ink leading-tight">Scale Room</h1>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600 bg-indigo-50 rounded-full px-2 py-0.5">Private · you only</span>
      </div>

      {/* Overview (this page) · Outbound (the full pipeline + ad account) */}
      <ScaleTabs active="overview" />

      {/* 1. Talk to your brain — ask what to do next, right at the top. */}
      <ScaleChat />

      {/* 2. The #1 constraint + collapsed Protect / Grow */}
      <GrowthBoard initial={growthBrief as GrowthBrief | null} currentSources={sourceFlags} />

      {/* 3. ACT NOW — what needs Mitchell today. Streamed so the shell +
          constraint render instantly instead of the whole page blocking on the
          inbox/reactivate AI sort. */}
      <div className="pt-1">
        <div className="flex items-center gap-1.5 px-1 mb-2">
          <span className="w-2 h-2 rounded-full bg-indigo-500" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Act now</span>
        </div>
        <Suspense fallback={<div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-soft">Sorting your inbox, pitches and quiet clients…</div>}>
          <ActNowSection />
        </Suspense>
      </div>

      {/* 4. THE NUMBERS — reference, below the actions */}
      <div className="pt-1">
        <div className="flex items-center gap-1.5 px-1 mb-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">The numbers</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {cards.map((c) => {
            const h = HUE[c.hue];
            return (
              <div key={c.label} className={"rounded-2xl border p-4 shadow-soft " + h.card}>
                <div className={"text-[11px] font-semibold " + h.label}>{c.label}</div>
                <div className={"mt-1 text-2xl font-bold tabular-nums " + h.value}>{c.value}</div>
              </div>
            );
          })}
        </div>
        {(sourceFlags.facebook || sourceFlags.outbound) && (
          <div className="mt-3">
            <Suspense fallback={<ScaleAcquisitionLoading {...sourceFlags} />}>
              <ScaleAcquisitionSection sources={sourceFlags} />
            </Suspense>
          </div>
        )}
      </div>

      {/* 5. What we're optimizing for */}
      <MemoryEditor initial={memories as ScaleMemory[]} />
    </div>
  );
}

// The slow part of the page — inbox AI-sort, reactivate AI-sort, quiet clients —
// streamed under a Suspense boundary so it never blocks the shell/constraint.
// Rendered below the owner gate; every fetch fails soft.
async function ActNowSection() {
  const [reachOut, reactivate, inbox, followUps] = await Promise.all([
    getReachOutClients().catch(() => []),
    getReactivatePitches().catch(() => []),
    loadSortedInbox(),
    getFollowUpLeads().catch(() => ({ booked: [], noResponse: [] }))
  ]);
  const followCount = followUps.booked.length + followUps.noResponse.length;
  const hasAny = inbox.threads.length > 0 || reactivate.length > 0 || reachOut.length > 0 || followCount > 0;
  if (!hasAny) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-soft">Nothing needs you right now. 🎉</div>;
  }
  return <ActNowTabs inbox={inbox.threads} inboxNote={inbox.note} reactivate={reactivate} reachOut={reachOut} followUps={followUps} />;
}

// Mitchell's inbox, sorted (owner-only, gated upstream). Fails soft to a note.
async function loadSortedInbox(): Promise<{ threads: InboxThread[]; note: string | null }> {
  try {
    const accounts = await listAccounts();
    const acct = accounts.find((a) => (a.email ?? "").toLowerCase() === OWNER_EMAIL);
    if (!acct) return { threads: [], note: `No Missive inbox found for ${OWNER_EMAIL}.` };
    const raw = await listThreads({ mailboxId: acct.id, folder: "INBOX", status: "open", limit: 40 });
    const mapped = raw.map((t) => ({
      id: t.id,
      subject: t.subject || "(no subject)",
      from: t.last_from ?? (t.participants?.[0] ?? "unknown"),
      snippet: t.last_snippet ?? "",
      lastAt: t.last_message_at
    }));
    const threads = await categorizeInbox(mapped);
    return { threads, note: threads.length === 0 ? "Nothing needs a reply right now." : null };
  } catch (err) {
    return { threads: [], note: err instanceof Error ? err.message : "Inbox unavailable." };
  }
}

// Only ever rendered below the owner gate above. Neither fetch throws. A source
// switched off is never called — not fetched and discarded, not called at all.
async function ScaleAcquisitionSection({ sources }: { sources: ScaleSourceFlags }) {
  const [revenue, outbound, meta] = await Promise.all([
    sources.facebook ? getFacebookRevenue() : undefined,
    sources.outbound ? getOutboundSummary() : undefined,
    // Live Meta stats come straight from Meta's API — independent of the ads
    // dashboard's pipeline DB, so they still show when the board query 500s.
    sources.outbound ? getOutboundMeta(7) : undefined
  ]);
  return <ScaleAcquisition revenue={revenue} outbound={outbound} meta={meta} />;
}
