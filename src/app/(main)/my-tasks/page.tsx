import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { TaskCard } from "@/components/TaskCard";
import { StatCard } from "@/components/StatCard";
import { PageStagger } from "@/components/PageStagger";
import { AlertTriangle, Clock, Hourglass, Target, ListChecks } from "lucide-react";
import type { Task } from "@/lib/types";

// Source of truth for tasks is now Supabase. Server component so we read
// fresh on every navigation; opt out of route-handler-style caching.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function focusSort(a: Task, b: Task) {
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  const aBlocks = a.blocksTaskIds.length, bBlocks = b.blocksTaskIds.length;
  if (aBlocks !== bBlocks) return bBlocks - aBlocks;
  const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
  const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
  return aDue - bDue;
}

function isImminent(t: Task) {
  if (!t.dueDate) return false;
  return new Date(t.dueDate).getTime() < Date.now() + 3 * 86400000;
}

function rowToTask(t: any): Task {
  return {
    id: t.id,
    title: t.title,
    description: t.description ?? "",
    status: t.status,
    priority: t.priority,
    estimatedHours: Number(t.estimated_hours),
    actualHours: Number(t.actual_hours ?? 0),
    tags: t.tags ?? [],
    departmentId: t.department_id,
    assigneeId: t.assignee_id,
    creatorId: t.creator_id,
    projectId: t.project_id,
    dueDate: t.due_date,
    inactiveFlag: !!t.inactive_flag,
    lastActivityAt: t.last_activity_at,
    createdAt: t.created_at,
    blocksTaskIds: t.blocks_task_ids ?? []
  };
}

export default async function MyTasksPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const supabase = getSupabaseAdmin();
  const { data: rows } = await supabase
    .from("tasks")
    .select("*")
    .eq("assignee_id", me.id)
    .neq("status", "done");

  const mine = (rows ?? []).map(rowToTask).sort(focusSort);

  const urgentCount = mine.filter((t) => t.priority === "critical" || t.status === "urgent").length;
  const dueWeek = mine.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < Date.now() + 7 * 86400000).length;
  const blocked = mine.filter((t) => t.status === "waiting_on_client").length;

  return (
    <PageStagger className="space-y-5 max-w-7xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold">My focus</h1>
        <p className="text-sm text-muted mt-1">
          Sorted by priority → blockers → deadline. Low-priority items further out are dimmed.
        </p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Open" value={mine.length} icon={<ListChecks className="w-4 h-4" />} tone="blue" delay={0.04} />
        <StatCard label="Urgent" value={urgentCount} icon={<AlertTriangle className="w-4 h-4" />} tone="purple" delay={0.10} />
        <StatCard label="Due this week" value={dueWeek} icon={<Clock className="w-4 h-4" />} tone="violet" delay={0.16} />
        <StatCard label="Blocked / waiting" value={blocked} icon={<Hourglass className="w-4 h-4" />} tone="indigo" delay={0.22} />
      </div>

      <div>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Target className="w-4 h-4 text-accent" />
          Focus queue
        </h2>
        {mine.length === 0 ? (
          <div className="card p-10 text-center">
            <div className="w-16 h-16 rounded-2xl bg-violet-100 text-violet-600 grid place-items-center mx-auto mb-3">
              <ListChecks className="w-8 h-8" />
            </div>
            <div className="text-base font-medium">Inbox zero 🎉</div>
            <div className="text-sm text-muted mt-1">
              Nothing assigned to you right now. Take a beat, then queue something up.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {mine.map((t) => (
              <TaskCard key={t.id} task={t} dim={t.priority === "low" && !isImminent(t)} />
            ))}
          </div>
        )}
      </div>
    </PageStagger>
  );
}
