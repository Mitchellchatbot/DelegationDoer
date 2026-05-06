"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { users, departments, tasks } from "@/lib/mock-data";
import { OrgChart } from "@/components/OrgChart";
import { useCurrentUser } from "@/lib/user-context";
import { Users as UsersIcon, ShieldAlert } from "lucide-react";

// Org-chart view scoped to the current dept head's departments. CEOs are
// nudged to /ceo (which has the full version + management tabs); workers
// don't get team scope, so they're bounced home.
export default function TeamOverviewPage() {
  const currentUser = useCurrentUser();
  const router = useRouter();

  if (currentUser.role === "ceo") {
    // SPA-friendly nudge — middleware doesn't know roles.
    if (typeof window !== "undefined") router.replace("/ceo");
    return null;
  }
  if (currentUser.role !== "department_head") {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">Department heads only</div>
        <div className="text-sm text-muted mt-1">
          This view shows your team's open tasks and deadlines. You're a worker —
          check <a href="/my-tasks" className="text-accent underline">My Tasks</a> instead.
        </div>
      </div>
    );
  }

  const myDeptIds = currentUser.departmentIds;

  // Scope departments to the head's home departments. Scope users to anyone
  // who lives in those departments (workers + co-heads + the head themselves).
  const scopedDepts = useMemo(
    () => departments.filter((d) => myDeptIds.includes(d.id)),
    [myDeptIds]
  );
  const scopedUsers = useMemo(
    () => users.filter((u) => u.departmentIds.some((d) => myDeptIds.includes(d))),
    [myDeptIds]
  );
  // Tasks are filtered to assignees in the visible scope so we don't pull
  // in cross-department work that wouldn't render anyway.
  const scopedTasks = useMemo(() => {
    const visibleIds = new Set(scopedUsers.map((u) => u.id));
    return tasks.filter((t) => t.assigneeId && visibleIds.has(t.assigneeId));
  }, [scopedUsers]);

  const deptNames = scopedDepts.map((d) => d.name).join(", ") || "your team";

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <header>
        <div className="flex items-center gap-2 text-xs text-muted uppercase tracking-wide">
          <UsersIcon className="w-3 h-3" /> Team Overview
        </div>
        <h1 className="text-xl font-medium mt-1">{deptNames}</h1>
        <p className="text-sm text-muted mt-1">
          Everyone reporting into your department(s), with their open tasks and
          deadlines. Click a name to see their full profile, or a task to open it.
        </p>
      </header>

      <OrgChart
        users={scopedUsers}
        departments={scopedDepts}
        tasks={scopedTasks}
        // No CEO root — dept-head view starts at the dept level.
        ceo={null}
      />
    </div>
  );
}
