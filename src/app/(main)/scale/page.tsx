import { Suspense } from "react";
import { Inter } from "next/font/google";
import { notFound, redirect } from "next/navigation";
import { Rocket, Mail, Linkedin, Infinity as InfinityIcon, ExternalLink } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner, OWNER_EMAIL } from "@/lib/access";
import { listMemories } from "@/lib/brain-memory";
import { listAccounts, listThreads } from "@/lib/missive-client";
import { categorizeInbox } from "@/lib/owner-inbox";
import { GrowthBoard, type GrowthBrief, type GrowItem } from "@/components/GrowthBoard";
import { getLatestGrowthBrief } from "@/lib/growth-brain";
import { MemoryEditor, type ScaleMemory } from "@/components/MemoryEditor";
import { ActNowTabs } from "@/components/ActNowTabs";
import { getReachOutClients, getReactivatePitches, getFollowUpLeads, getLinkedInTargets, getScaleKpis, getScaleMeta, getScaleFinance, type ScaleKpi, type ScaleFinance } from "@/lib/scale-actions";
import { type InboxThread } from "@/components/InboxCopilot";
import { LinkedInModule } from "@/components/LinkedInModule";
import { MetaLive } from "@/components/ScaleAcquisition";
import type { ScaleSourceFlags } from "@/lib/scale-sources-types";
import { ScaleChat } from "@/components/ScaleChat";
import { ScaleTabs } from "@/components/ScaleTabs";

export const dynamic = "force-dynamic";

// Inter, scoped to the Scale Room, for the crisp reference-dashboard feel.
const inter = Inter({ subsets: ["latin"], display: "swap" });

// External tools the room links out to, opened from their brand logo.
const OUTLOOK_URL = "https://outlook.office.com/mail/";
const LINKEDIN_URL = "https://www.linkedin.com/feed/";
const META_ADS_URL = "https://adsmanager.facebook.com/";

// Owner-only command center — Mitchell + the brain in one place: what to do to
// scale, the emails/leads that need him, live Meta performance, and the
// priorities the brain optimizes toward (which it learns from his 👍/👎).
// Finance lives on /finance, not here. Same 404 gate as /finance.
export default async function ScalePage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  const [memories, growthBrief] = await Promise.all([
    listMemories().catch(() => []),
    getLatestGrowthBrief().catch(() => null)
  ]);
  const brief = growthBrief as GrowthBrief | null;
  // The room always reads both acquisition sources — Facebook (booked calls)
  // and the outbound pipeline. No toggles: Mitchell wants both, always.
  const sourceFlags: ScaleSourceFlags = { facebook: true, outbound: true };

  return (
    <div className={inter.className + " space-y-6 max-w-5xl mx-auto text-slate-900"}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-slate-900 text-white grid place-items-center shrink-0">
          <Rocket className="w-4 h-4" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 leading-tight">Scale Room</h1>
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Private</span>
      </div>

      <ScaleTabs active="overview" />

      {/* Top row: the brain (hero) + a side panel of the one move + the numbers. */}
      <div className="grid lg:grid-cols-[1.55fr_1fr] gap-5 items-stretch">
        <ScaleChat opening={buildOpening(brief)} />
        <div className="flex flex-col gap-5">
          <DoThisNext item={brief?.grow?.[0]} />
          <Suspense fallback={<GlanceLoading />}>
            <RoomToScaleSection />
          </Suspense>
          <Suspense fallback={<GlanceLoading />}>
            <AtAGlanceSection />
          </Suspense>
        </div>
      </div>

      {/* The #1 constraint + Protect / Grow — each item has 👍/👎 so the brain
          learns from Mitchell's feedback (the self-learning system). */}
      <GrowthBoard initial={brief} currentSources={sourceFlags} />

      {/* Inbox / email — opens in Outlook. */}
      <section>
        <ToolHeader icon={<Mail className="w-4 h-4" />} tint="#0F6CBD" name="Inbox" tagline="reply, follow up, reactivate — opens in Outlook" href={OUTLOOK_URL} />
        <Suspense fallback={<Loading>Sorting your inbox, pitches and quiet clients…</Loading>}>
          <ActNowSection />
        </Suspense>
      </section>

      {/* LinkedIn — write a post + the 5 to DM. */}
      <section>
        <ToolHeader icon={<Linkedin className="w-4 h-4" />} tint="#0A66C2" name="LinkedIn" tagline="post of the day + 5 to DM" href={LINKEDIN_URL} />
        <Suspense fallback={<Loading>Loading your LinkedIn targets…</Loading>}>
          <LinkedInSection />
        </Suspense>
      </section>

      {/* Meta ads — live performance + today's fixes. */}
      <section>
        <ToolHeader icon={<InfinityIcon className="w-4 h-4" />} tint="#0866FF" name="Meta ads" tagline="last 7 days + today's fixes" href={META_ADS_URL} />
        <Suspense fallback={<Loading>Loading Meta ads…</Loading>}>
          <MetaSection />
        </Suspense>
      </section>

      {/* What we're optimizing for (persistent memory the brain builds on). */}
      <MemoryEditor initial={memories as ScaleMemory[]} />
    </div>
  );
}

// A branded section header: the tool's logo (colored tile) opens the tool, with
// a plain-language tagline beside it.
function ToolHeader({ icon, tint, name, tagline, href }: { icon: React.ReactNode; tint: string; name: string; tagline: string; href: string }) {
  return (
    <div className="flex items-center gap-2.5 px-1 mb-2.5">
      <a href={href} target="_blank" rel="noopener noreferrer" className="group inline-flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg grid place-items-center text-white shrink-0" style={{ backgroundColor: tint }}>{icon}</span>
        <span className="text-[14px] font-semibold text-slate-900 group-hover:underline inline-flex items-center gap-1">{name}<ExternalLink className="w-3 h-3 text-slate-400" /></span>
      </a>
      <span className="text-[12px] text-slate-400 truncate">· {tagline}</span>
    </div>
  );
}

// Side-panel card: the single highest-leverage move, from the brief's top Grow
// item. Sits right next to the chat so the one thing to do is always in view.
function DoThisNext({ item }: { item?: GrowItem }) {
  if (!item) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Do this next</div>
        <div className="text-[13px] text-slate-500">Run the brain to surface today&apos;s highest-leverage move.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2.5">Do this next</div>
      <div className="text-[15px] font-semibold text-slate-900 leading-snug">{item.title}</div>
      {item.estValue && (
        <div className="text-[13px] font-semibold text-emerald-600 mt-1.5">{item.estValue}</div>
      )}
      {item.action && <div className="text-[13px] text-slate-500 mt-2.5 leading-relaxed line-clamp-4">{item.action}</div>}
    </div>
  );
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// The brain "speaks first": a short brief built from the latest run (no model
// call), so the chat leads with today's focus instead of an empty box.
function buildOpening(brief: GrowthBrief | null): string | undefined {
  if (!brief) return undefined;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  const lines: string[] = [`**${greet}, Mitchell — here's your focus today.**`];
  const g = brief.grow?.[0];
  if (g) lines.push(`**Do this next:** ${g.title}${g.estValue ? ` (${g.estValue})` : ""}`);
  const p = brief.protect?.[0];
  if (p) lines.push(`**Watch:** ${p.title}`);
  lines.push("Ask me anything, or tap a question below.");
  return lines.join("\n\n");
}

// Side-panel card: the finances that inform scaling — MRR, avg client value,
// what the booked pipeline is worth, and the gap to the next milestone.
function RoomToScale({ f }: { f: ScaleFinance }) {
  const closeToGoal = f.potentialFromBooked > 0 && f.goal > f.mrr
    ? Math.min(100, Math.round((f.potentialFromBooked / (f.goal - f.mrr)) * 100))
    : 0;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Room to scale</div>
      <div className="divide-y divide-slate-100">
        <div className="flex items-center justify-between py-2.5"><span className="text-[13px] text-slate-500">MRR</span><span className="text-[15px] font-semibold tabular-nums text-slate-900">{money(f.mrr)}</span></div>
        <div className="flex items-center justify-between py-2.5"><span className="text-[13px] text-slate-500">Avg client</span><span className="text-[15px] font-semibold tabular-nums text-slate-900">{money(f.avgClient)}<span className="text-[12px] font-normal text-slate-400">/mo</span></span></div>
        <div className="flex items-center justify-between py-2.5"><span className="text-[13px] text-slate-500">{f.bookedCalls} booked calls</span><span className="text-[15px] font-semibold tabular-nums text-emerald-600">up to {money(f.potentialFromBooked)}<span className="text-[12px] font-normal text-slate-400">/mo</span></span></div>
      </div>
      <div className="mt-3 pt-3 border-t border-slate-100 text-[12.5px] text-slate-600 leading-relaxed">
        ~{f.clientsToGoal} new clients from {money(f.goal)} MRR.{closeToGoal > 0 ? ` Closing your booked calls covers ~${closeToGoal}% of the gap.` : ""}
      </div>
    </div>
  );
}
async function RoomToScaleSection() {
  const f = await getScaleFinance().catch(() => null);
  if (!f) return null;
  return <RoomToScale f={f} />;
}

// Side-panel card: the numbers, compact — for reference, not a hero strip.
function AtAGlance({ kpis, stale }: { kpis: ScaleKpi[]; stale: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">At a glance</div>
      <div className="divide-y divide-slate-100">
        {kpis.map((k) => (
          <div key={k.label} className="flex items-center justify-between py-2.5">
            <span className="text-[13px] text-slate-500">{k.label}</span>
            <span className="text-[15px] font-semibold tabular-nums text-slate-900 inline-flex items-center gap-1.5">
              {k.value}
              {k.delta && <span className={"text-[11px] font-medium " + (k.delta.good ? "text-emerald-600" : "text-rose-500")}>{k.delta.dir === "up" ? "↑" : "↓"}{k.delta.text.replace(/ vs.*/, "")}</span>}
            </span>
          </div>
        ))}
      </div>
      {stale && <div className="text-[10px] text-slate-400 mt-2">Last good read — the ads dashboard is catching up.</div>}
    </div>
  );
}
function GlanceLoading() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="h-2.5 w-20 bg-slate-100 rounded animate-pulse mb-4" />
      {[0, 1, 2].map((i) => <div key={i} className="h-4 w-full bg-slate-50 rounded animate-pulse mb-2.5" />)}
    </div>
  );
}
async function AtAGlanceSection() {
  const { kpis, stale } = await getScaleKpis();
  return <AtAGlance kpis={kpis} stale={stale} />;
}

function Loading({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-sm">{children}</div>;
}

// The slow part of the page — inbox AI-sort, reactivate AI-sort, quiet clients,
// booked pipeline — streamed under Suspense. Every fetch fails soft.
async function ActNowSection() {
  const [reachOut, reactivate, inbox, followUps] = await Promise.all([
    getReachOutClients().catch(() => []),
    getReactivatePitches().catch(() => []),
    loadSortedInbox(),
    getFollowUpLeads().catch(() => ({ booked: [], noResponse: [] }))
  ]);
  const followCount = followUps.booked.length + followUps.noResponse.length;
  const hasAny = inbox.threads.length > 0 || reactivate.length > 0 || reachOut.length > 0 || followCount > 0;
  if (!hasAny) return <Loading>Nothing needs you right now. 🎉</Loading>;
  return <ActNowTabs inbox={inbox.threads} inboxNote={inbox.note} reactivate={reactivate} reachOut={reachOut} followUps={followUps} />;
}

// Mitchell's inbox, sorted (owner-only, gated upstream). Fails soft to a note.
async function loadSortedInbox(): Promise<{ threads: InboxThread[]; note: string | null }> {
  try {
    const accounts = await listAccounts();
    const acct = accounts.find((a) => (a.email ?? "").toLowerCase() === OWNER_EMAIL);
    if (!acct) return { threads: [], note: `No inbox found for ${OWNER_EMAIL}.` };
    const raw = await listThreads({ mailboxId: acct.id, folder: "INBOX", status: "open", limit: 40 });
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

async function MetaSection() {
  const meta = await getScaleMeta();
  return <MetaLive meta={meta ?? { ok: false, error: "the ads dashboard didn't respond" }} />;
}

async function LinkedInSection() {
  const targets = await getLinkedInTargets(5).catch(() => []);
  return <LinkedInModule targets={targets} />;
}
