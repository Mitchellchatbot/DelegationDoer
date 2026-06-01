import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { isApprover } from "@/lib/email-approvers";
import {
  getTodayTasksForUser,
  getNeedsYouCounts,
  getDayBookendStatus,
  getSeoBriefsForHome,
  getLeaderPulse,
  getPostsPerClient,
  getStalledTaskCount,
  getLeaderOpenTasks
} from "@/lib/home-data";
import { HomeWorker } from "@/components/HomeWorker";
import { HomeLeaderHero } from "@/components/HomeLeaderHero";
import { HomeSeoBriefs } from "@/components/HomeSeoBriefs";
import { HomePulseCard } from "@/components/HomePulseCard";
import { HomeChartsRow } from "@/components/HomeChartsRow";
import { LeaderTodoList } from "@/components/LeaderTodoList";
import { DayBookends } from "@/components/DayBookends";

export const dynamic = "force-dynamic";

// /home — the calm landing surface. Branches by role:
//   - Workers see HomeWorker (clock + today's tasks)
//   - Department heads see HomeLeader scoped to their dept
//   - Leaders + admins see HomeLeader unscoped
//
// Plus a Day Bookends card pinned at the top for anyone who has to
// submit SOD/EOD (workers + heads). Leaders and stealth admins are
// exempt from those rituals (same exemption as ClockGate).
//
// Everything's server-fetched so the page hydrates with real numbers
// instead of null-then-flash.
export default async function HomePage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const isLeaderRole = isLeader(me) || !!me.isAdmin;
  const isHead = me.role === "department_head";
  const hourLocal = new Date().getHours();

  // Day Bookends — only for people who actually submit SOD/EOD.
  // Leaders + stealth admins don't, so we skip the query and the card.
  const dayBookends = !isLeaderRole ? await getDayBookendStatus(userId) : null;

  if (isLeaderRole || isHead) {
    // Leader/head view. Heads get their dept scope; leaders see all.
    const scopedDepartmentIds = isHead ? (me.departmentIds ?? []) : null;
    const scopeLabel = isHead && scopedDepartmentIds && scopedDepartmentIds.length > 0
      ? scopedDepartmentIds.length === 1 ? primaryDeptLabel(scopedDepartmentIds[0]) : "Your departments"
      : undefined;

    const canApprove = isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin });

    // SEO briefs only render for leaders/admins (they wrote them) and
    // for SEO dept heads. SEO workers see the same card in the worker
    // branch below.
    const showSeoBriefs =
      isLeaderRole || (isHead && (me.departmentIds ?? []).includes("dep_seo"));

    // Restructured leader home — the notification feed (What's moving)
    // is the centerpiece, charts row + Apple-style reminder list flank
    // it. Old Client health / Team today / Due today cards are gone:
    // every signal they carried now lives inside the feed, sorted by
    // recency. Removing the duplicates cut the page from 5 stacked
    // cards (lots of scroll) to a feed + two glance tiles + a todo.
    const [needsYou, seoBriefs, pulse, postsPerClient, stalledCount, leaderTodos] = await Promise.all([
      getNeedsYouCounts({
        canApprove,
        visibleDepartmentIds: scopedDepartmentIds,
        hourLocal,
        // Inboxes unread is owned by the badges endpoint (needs the
        // missive integration). The strip can render without it on
        // first paint; the sidebar badge fills it in on hydrate.
        inboxesUnread: 0
      }),
      showSeoBriefs ? getSeoBriefsForHome(20) : Promise.resolve([]),
      // What's-moving feed — unified notification surface across
      // tasks, approvals, alerts, and clients. Higher cap (60) since
      // it's the primary surface now.
      getLeaderPulse({ scopedDepartmentIds, total: 60 }),
      getPostsPerClient(),
      getStalledTaskCount(),
      getLeaderOpenTasks(userId, 30)
    ]);

    return (
      <div className="space-y-4 max-w-7xl mx-auto">
        {dayBookends && <DayBookends status={dayBookends} hourLocal={hourLocal} />}
        <HomeLeaderHero
          meName={me.name}
          needsYou={needsYou}
          scopeLabel={scopeLabel}
        />
        {/* Notifications — the focus of the new leader home. */}
        <HomePulseCard events={pulse} />
        {/* Glance tiles — posts-per-client + stalled stat */}
        <HomeChartsRow postsPerClient={postsPerClient} stalledCount={stalledCount} />
        {/* Apple-Reminders-style todo for the leader's own tasks. */}
        <LeaderTodoList tasks={leaderTodos} />
        {showSeoBriefs && <HomeSeoBriefs rows={seoBriefs} />}
      </div>
    );
  }

  // Worker view. Today's tasks; the clock provider is client-side
  // (context). Day Bookends now owns the SOD/EOD prompts — HomeWorker
  // no longer renders its own EOD nudge banner.
  const isSeoWorker = (me.departmentIds ?? []).includes("dep_seo");
  const [tasks, seoBriefs] = await Promise.all([
    getTodayTasksForUser(userId, 8),
    isSeoWorker ? getSeoBriefsForHome(20) : Promise.resolve([])
  ]);

  return (
    <div className="space-y-3 max-w-3xl">
      {dayBookends && <DayBookends status={dayBookends} hourLocal={hourLocal} />}
      <HomeWorker meName={me.name} tasks={tasks} />
      {isSeoWorker && <HomeSeoBriefs rows={seoBriefs} />}
    </div>
  );
}

// Best-effort dept name from id. We don't have a sync getter, and the
// existing dept catalog lives behind getDepartments() which is async.
// For the header label we just titlecase the id suffix; if it doesn't
// look like a dep_xxx id we render undefined and the header shows
// generic "Today" instead.
function primaryDeptLabel(deptId: string): string | undefined {
  if (!deptId.startsWith("dep_")) return undefined;
  const slug = deptId.slice(4);
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
