import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { Rocket, TrendingUp, ShieldAlert } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner, OWNER_EMAIL } from "@/lib/access";
import { listMemories } from "@/lib/brain-memory";
import { listAccounts, listThreads } from "@/lib/missive-client";
import { categorizeInbox } from "@/lib/owner-inbox";
import { GrowthBoard, type GrowthBrief } from "@/components/GrowthBoard";
import { getLatestGrowthBrief } from "@/lib/growth-brain";
import { MemoryEditor, type ScaleMemory } from "@/components/MemoryEditor";
import { ActNowTabs } from "@/components/ActNowTabs";
import { getReachOutClients, getReactivatePitches, getFollowUpLeads, getLinkedInTargets } from "@/lib/scale-actions";
import { type InboxThread } from "@/components/InboxCopilot";
import { LinkedInModule } from "@/components/LinkedInModule";
import { MetaLive } from "@/components/ScaleAcquisition";
import { getOutboundMeta } from "@/lib/outbound-meta";
import type { ScaleSourceFlags } from "@/lib/scale-sources-types";
import { ScaleChat } from "@/components/ScaleChat";
import { ScaleTabs } from "@/components/ScaleTabs";

export const dynamic = "force-dynamic";

// Owner-only command center — Mitchell + the brain in one place: what to do to
// scale, the emails/leads that need him, live Meta performance, and the
// priorities the brain optimizes toward. Finance lives on /finance, not here.
// Same 404 gate as /finance.
export default async function ScalePage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  const [memories, growthBrief] = await Promise.all([
    listMemories().catch(() => []),
    getLatestGrowthBrief().catch(() => null)
  ]);
  // The room always reads both acquisition sources — Facebook (booked calls)
  // and the outbound pipeline. No toggles: Mitchell wants both, always.
  const sourceFlags: ScaleSourceFlags = { facebook: true, outbound: true };

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

      {/* 2. Brain highlights — the single biggest opportunity + top risk, always
          visible (the rest of Grow/Protect stays in the board below). */}
      {growthBrief && <BrainHighlights brief={growthBrief as GrowthBrief} />}

      {/* 3. The #1 constraint + collapsed Protect / Grow */}
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

      {/* 4. LinkedIn — today's post to publish + the 5 ICP people to message. */}
      <div className="pt-1">
        <div className="flex items-center gap-1.5 px-1 mb-2">
          <span className="w-2 h-2 rounded-full bg-sky-500" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">LinkedIn</span>
        </div>
        <Suspense fallback={<div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-soft">Loading your LinkedIn targets…</div>}>
          <LinkedInSection />
        </Suspense>
      </div>

      {/* 5. Meta ads — live performance + today's fixes (same read the 8am recap
          sends). Streams; the card hides itself when the ads dashboard is down.
          Finance lives on /finance, deliberately not here. */}
      <div className="pt-1">
        <div className="flex items-center gap-1.5 px-1 mb-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Meta ads · daily recap</span>
        </div>
        <Suspense fallback={<div className="text-[12px] text-muted px-1">Loading Meta ads…</div>}>
          <MetaSection />
        </Suspense>
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
    // Threads Mitchell has dismissed from the room — hidden here only, the real
    // Missive email is untouched.
    const dismissedRes = await getSupabaseAdmin().from("inbox_dismissals").select("thread_id");
    const dismissed = new Set((dismissedRes.data ?? []).map((r) => r.thread_id as string));
    const mapped = raw
      .filter((t) => !dismissed.has(t.id))
      .map((t) => ({
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

// The single biggest opportunity + top risk from the latest brief, always
// visible so the money-idle item isn't buried in the collapsed Grow dropdown.
function BrainHighlights({ brief }: { brief: GrowthBrief }) {
  const g = brief.grow?.[0];
  const p = brief.protect?.[0];
  if (!g && !p) return null;
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      {g && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3.5 shadow-soft">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Biggest opportunity</div>
          <div className="text-[13px] font-semibold text-ink mt-1 leading-snug line-clamp-2">{g.title}</div>
          {g.estValue && <div className="text-[12px] font-bold text-emerald-700 mt-0.5">{g.estValue}</div>}
        </div>
      )}
      {p && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-3.5 shadow-soft">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-700 flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Top risk</div>
          <div className="text-[13px] font-semibold text-ink mt-1 leading-snug line-clamp-2">{p.title}</div>
        </div>
      )}
    </div>
  );
}

// Live Meta ad performance only — read straight from Meta's API, independent of
// the ads dashboard's pipeline DB, so it shows whenever the dashboard is up.
// Renders nothing when the read fails (MetaLive is silent on error).
async function MetaSection() {
  const meta = await getOutboundMeta(7);
  return <MetaLive meta={meta} />;
}

// The 5 ICP people to message on LinkedIn today, from the live pipeline. Reads
// the (cached) board, so it shares the Follow-up tab's one board fetch.
async function LinkedInSection() {
  const targets = await getLinkedInTargets(5).catch(() => []);
  return <LinkedInModule targets={targets} />;
}
