import { redirect } from "next/navigation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { isApprover } from "@/lib/email-approvers";
import {
  getTodayTasksForUser,
  getTeamStatusToday,
  getTodayDeliverables,
  getNeedsYouCounts,
  getClientHealthOverview,
  getDayBookendStatus
} from "@/lib/home-data";
import { HomeWorker } from "@/components/HomeWorker";
import { HomeLeader } from "@/components/HomeLeader";
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

    const [team, deliverables, needsYou, clientHealth] = await Promise.all([
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
      }),
      // Client health is org-wide for now — even heads benefit from
      // seeing accounts going cold across the agency, not just their
      // dept's. Easy to scope later if it gets noisy.
      getClientHealthOverview(8)
    ]);

    return (
      <div className="space-y-3 max-w-5xl">
        {dayBookends && <DayBookends status={dayBookends} hourLocal={hourLocal} />}
        <HomeLeader
          meName={me.name}
          needsYou={needsYou}
          team={team}
          deliverables={deliverables}
          clientHealth={clientHealth}
          scopeLabel={scopeLabel}
        />
      </div>
    );
  }

  // Worker view. Today's tasks; the clock provider is client-side
  // (context). Day Bookends now owns the SOD/EOD prompts — HomeWorker
  // no longer renders its own EOD nudge banner.
  const tasks = await getTodayTasksForUser(userId, 8);

  return (
    <div className="space-y-3 max-w-3xl">
      {dayBookends && <DayBookends status={dayBookends} hourLocal={hourLocal} />}
      <HomeWorker meName={me.name} tasks={tasks} />
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
