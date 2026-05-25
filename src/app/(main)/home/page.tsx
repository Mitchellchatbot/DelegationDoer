import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { isApprover } from "@/lib/email-approvers";
import {
  getTodayTasksForUser,
  getEodSubmittedTodayForUser,
  getTeamStatusToday,
  getTodayDeliverables,
  getNeedsYouCounts
} from "@/lib/home-data";
import { HomeWorker } from "@/components/HomeWorker";
import { HomeLeader } from "@/components/HomeLeader";

export const dynamic = "force-dynamic";

// /home — the calm landing surface. Branches by role:
//   - Workers see HomeWorker (clock + today's tasks + EOD nudge)
//   - Department heads see HomeLeader scoped to their dept
//   - Leaders + admins see HomeLeader unscoped
//
// Everything's server-fetched so the page hydrates with real numbers
// instead of null-then-flash.
export default async function HomePage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const isLeaderRole = isLeader(me) || !!me.isAdmin;
  const isHead = me.role === "department_head";

  if (isLeaderRole || isHead) {
    // Leader/head view. Heads get their dept scope; leaders see all.
    const scopedDepartmentIds = isHead ? (me.departmentIds ?? []) : null;
    const scopeLabel = isHead && scopedDepartmentIds && scopedDepartmentIds.length > 0
      ? scopedDepartmentIds.length === 1 ? primaryDeptLabel(scopedDepartmentIds[0]) : "Your departments"
      : undefined;

    const hourLocal = new Date().getHours();
    const canApprove = isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin });

    const [team, deliverables, needsYou] = await Promise.all([
      getTeamStatusToday(scopedDepartmentIds ?? undefined, 60),
      getTodayDeliverables(scopedDepartmentIds ?? undefined, 20),
      getNeedsYouCounts({
        canApprove,
        visibleDepartmentIds: scopedDepartmentIds,
        hourLocal,
        // Inboxes unread is owned by the badges endpoint (needs the
        // missive integration). The strip can render without it on
        // first paint; the sidebar badge fills it in on hydrate.
        inboxesUnread: 0
      })
    ]);

    return (
      <HomeLeader
        meName={me.name}
        needsYou={needsYou}
        team={team}
        deliverables={deliverables}
        scopeLabel={scopeLabel}
      />
    );
  }

  // Worker view. Three signals: today's tasks, EOD status, and the
  // clock provider (client-side via context).
  const [tasks, eodSubmitted] = await Promise.all([
    getTodayTasksForUser(userId, 8),
    getEodSubmittedTodayForUser(userId)
  ]);

  const hourLocal = new Date().getHours();
  // After 5pm, show the nudge unless we know they've already submitted.
  // If we can't tell (null), default to NOT showing it — we'd rather
  // miss the nudge than spam someone who already submitted.
  const showEodNudge = hourLocal >= 17 && eodSubmitted === false;

  return (
    <HomeWorker
      meName={me.name}
      tasks={tasks}
      showEodNudge={showEodNudge}
    />
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
