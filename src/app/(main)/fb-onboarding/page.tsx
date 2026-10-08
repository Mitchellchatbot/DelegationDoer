import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Rocket } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { NewFbOnboardingButton } from "@/components/NewFbOnboardingButton";
import type { Priority } from "@/lib/types";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsers } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canSeeFbOnboarding, listOnboardings, FB_DEPT } from "@/lib/fb-onboarding-data";
import { FbOnboardingBrowser } from "@/components/FbOnboardingBrowser";
import { STAGES, elapsedDays } from "@/lib/fb-onboarding";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Live keeps growing, so only recent hand-overs get a card — but always show
// a few, so the section isn't empty on a slow month.
const LIVE_WINDOW_DAYS = 30;
const LIVE_MIN = 4;

// Highest first. Used for the "Priority" sort mode — the default, "Longest
// waiting", never touches this.
const PRIORITY_RANK: Record<Priority, number> = { critical: 3, high: 2, medium: 1, low: 0 };

type SortMode = "age" | "priority";

export default async function FbOnboardingListPage({ searchParams }: { searchParams: { sort?: string } }) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  if (!canSeeFbOnboarding(me)) return notFound();

  const sortMode: SortMode = searchParams.sort === "priority" ? "priority" : "age";

  const [onboardings, users, { data: fbTasks }] = await Promise.all([
    listOnboardings(),
    getAllUsers(),
    getSupabaseAdmin()
      .from("tasks")
      .select("id, title")
      .eq("department_id", FB_DEPT)
      .is("deleted_at", null)
      .is("archived_at", null)
      .neq("status", "done")
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  const started = new Set(onboardings.map((o) => o.taskId));
  const unstartedTasks = (fbTasks ?? [])
    .filter((t) => !started.has(t.id as string))
    .map((t) => ({ id: t.id as string, title: t.title as string }));
  const fbPeople = users
    .filter((u) => (u.departmentIds ?? []).includes(FB_DEPT))
    .map((u) => ({ id: u.id, name: u.name }));
  const noteUsers = users.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null, email: u.email ?? null, role: u.role }));
  const assignees: Record<string, { id: string; name: string; avatarUrl: string | null }> = {};
  for (const u of users) assignees[u.id] = { id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null };

  // One flat list in stage order — the browser's strip groups it back into
  // stage runs, and the arrows walk it end to end.
  //
  // Within a stage: on-hold sinks to the bottom, then longest-in-stage first
  // (or highest priority first in "Priority" mode), with the started date as
  // the tiebreak so the order is stable between renders.
  //
  // Live is the exception — newest hand-over first, and only the recent ones,
  // since Live grows without bound.
  const inFlight = onboardings.filter((o) => o.stage !== "live");
  const live = onboardings
    .filter((o) => o.stage === "live")
    .sort((a, b) => ((b.completedAt ?? "") < (a.completedAt ?? "") ? -1 : 1));
  const liveRecent = live.filter((o) => (elapsedDays(o.completedAt) ?? 0) <= LIVE_WINDOW_DAYS);
  const liveShown = liveRecent.length >= LIVE_MIN ? liveRecent : live.slice(0, LIVE_MIN);
  const liveHidden = live.length - liveShown.length;

  const ordered = [
    ...STAGES.filter((st) => st !== "live").flatMap((st) =>
      inFlight
        .filter((o) => o.stage === st)
        .sort((a, b) =>
          Number(a.onHold) - Number(b.onHold) ||
          (sortMode === "priority" ? PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] : 0) ||
          (b.stageAgeDays ?? 0) - (a.stageAgeDays ?? 0) ||
          (a.startedAt < b.startedAt ? -1 : 1)
        )
    ),
    ...liveShown
  ];

  const waitingClient = inFlight.filter((o) => o.waitingOn === "client").length;
  const onHoldCount = inFlight.filter((o) => o.onHold).length;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Facebook"
        headline={["Client ", { accent: "onboarding" }]}
        subtitle="Access, launch details, their Scaled Sync account, the main zap build, setup and the Typeform test run for every new Facebook client."
        icon={<Rocket />}
        iconTone="violet"
        density="compact"
        metaLabel="On the plate:"
        meta={[
          { count: inFlight.length, label: "in flight" },
          { count: waitingClient, label: "waiting on the client", tone: "amber" as const },
          { count: onHoldCount, label: "on hold" },
          { count: unstartedTasks.length, label: "FB tasks not started" }
        ].filter((m) => m.count > 0)}
        trailing={<NewFbOnboardingButton people={fbPeople} existingTasks={unstartedTasks} />}
      />

      {onboardings.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          No onboardings yet. Start one with <span className="font-medium text-ink">New onboarding</span> and it appears under{" "}
          <span className="font-medium text-ink">Access</span>, then moves itself along as the checklist gets ticked.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 px-1">
            <p className="text-[12px] text-muted">
              Pick a client above, or use ← / → to move between them. Stages move themselves as the checklist gets ticked.
            </p>
            <div className="flex items-center gap-1 text-[11px] shrink-0">
              <span className="text-muted">Sort</span>
              <SortLink mode="age" current={sortMode}>Longest waiting</SortLink>
              <SortLink mode="priority" current={sortMode}>Priority</SortLink>
            </div>
          </div>

          <FbOnboardingBrowser
            onboardings={ordered}
            me={me}
            noteUsers={noteUsers}
            assignees={assignees}
          />

          {liveHidden > 0 && (
            <p className="px-1 text-[11px] text-muted">
              {liveHidden} more went live earlier than the last {LIVE_WINDOW_DAYS} days.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SortLink({ mode, current, children }: { mode: SortMode; current: SortMode; children: React.ReactNode }) {
  const active = mode === current;
  return (
    <Link
      href={mode === "age" ? "/fb-onboarding" : "/fb-onboarding?sort=priority"}
      className={cn(
        "px-2 py-0.5 rounded-full border transition-colors",
        active ? "border-accent/40 bg-accent/10 text-accent font-medium" : "border-border text-muted hover:bg-surface2"
      )}
    >
      {children}
    </Link>
  );
}

