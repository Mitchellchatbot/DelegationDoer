import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import {
  getTodayTasksForUser,
  getDayBookendStatus,
  getSeoBriefsForHome,
  getLeaderPulse,
  getStalledTaskCount,
  getLeaderOpenTasks,
  getWorstClientsByHealth
} from "@/lib/home-data";
import { HomeWorker } from "@/components/HomeWorker";
import { HomeLeaderHero } from "@/components/HomeLeaderHero";
import { HomeSeoBriefs } from "@/components/HomeSeoBriefs";
import { HomeClientHealthTable } from "@/components/HomeClientHealthTable";
import { HomeEmailNotifications } from "@/components/HomeEmailNotifications";
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
  // Leaders + stealth admins don't, and anyone with the per-user
  // dailyPromptsEnabled flag flipped off (e.g. Mitchell) is also
  // exempt. Skipping the query *and* the card prevents wasted reads
  // for the exempt cohort.
  //
  // dailyPromptsRequired force-opts a specific privileged account back
  // into the ritual (overrides the role exemption + a false flag), so
  // the card shows for them despite being a leader/admin.
  const dailyPromptsOn = me.dailyPromptsEnabled !== false;
  const dailyPromptsRequired = me.dailyPromptsRequired === true;
  const dayBookends = dailyPromptsRequired || (!isLeaderRole && dailyPromptsOn)
    ? await getDayBookendStatus(userId)
    : null;

  // Worst-clients health table is the first thing every role sees on
  // /home. Fetched here once and rendered in both branches below so the
  // anchor doesn't shift between roles.
  const worstByHealth = await getWorstClientsByHealth(10);

  if (isLeaderRole || isHead) {
    // Leader/head view. Heads get their dept scope; leaders see all.
    const scopedDepartmentIds = isHead ? (me.departmentIds ?? []) : null;
    const scopeLabel = isHead && scopedDepartmentIds && scopedDepartmentIds.length > 0
      ? scopedDepartmentIds.length === 1 ? primaryDeptLabel(scopedDepartmentIds[0]) : "Your departments"
      : undefined;

    const showSeoBriefs = true;

    const [seoBriefs, pulse, stalledCount, leaderTodos] = await Promise.all([
      showSeoBriefs ? getSeoBriefsForHome(20) : Promise.resolve([]),
      getLeaderPulse({ scopedDepartmentIds, total: 60 }),
      getStalledTaskCount(),
      getLeaderOpenTasks(userId, 30)
    ]);

    return (
      <div className="space-y-4 max-w-7xl mx-auto">
        {dayBookends && <DayBookends status={dayBookends} hourLocal={hourLocal} />}
        <HomeLeaderHero
          meName={me.name}
          scopeLabel={scopeLabel}
        />
        {/* Sites needing attention — pinned right under the hero so it's
            the first content every role lands on. */}
        <HomeClientHealthTable rows={worstByHealth} />
        {/* Notifications — the focus of the new leader home. */}
        <HomePulseCard events={pulse} />
        <HomeEmailNotifications onboarded={me.emailNotificationsOnboarded === true} />
        {/* Glance tile — stalled-work stat */}
        <HomeChartsRow stalledCount={stalledCount} />
        {/* Apple-Reminders-style todo for the leader's own tasks. */}
        <LeaderTodoList tasks={leaderTodos} />
        {showSeoBriefs && <HomeSeoBriefs rows={seoBriefs} />}
      </div>
    );
  }

  // Worker view. Today's tasks; the clock provider is client-side
  // (context). Day Bookends now owns the SOD/EOD prompts — HomeWorker
  // no longer renders its own EOD nudge banner.
  //
  // SEO briefs are visible to every worker too (Mitchell wants them
  // company-wide). Brief edit gate still applies — the PATCH route
  // still rejects non-leaders/heads, so a worker can read but not
  // write.
  const [tasks, seoBriefs] = await Promise.all([
    getTodayTasksForUser(userId, 8),
    getSeoBriefsForHome(20)
  ]);

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      {dayBookends && <DayBookends status={dayBookends} hourLocal={hourLocal} />}
      <HomeWorker meName={me.name} tasks={tasks} briefCount={seoBriefs.length} />
      <HomeClientHealthTable rows={worstByHealth} />
      <HomeEmailNotifications onboarded={me.emailNotificationsOnboarded === true} />
      <HomeSeoBriefs rows={seoBriefs} />
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
