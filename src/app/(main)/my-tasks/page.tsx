import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { TaskCard } from "@/components/TaskCard";
import { PageStagger } from "@/components/PageStagger";
import { Target, ListChecks, AlertTriangle, Clock, Hourglass } from "lucide-react";
import { PageHero } from "@/components/PageHero";
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
      <PageHero
        eyebrow={`Hey ${me.name.split(" ")[0]}`}
        headline={["Here's what's ", { accent: "on your plate" }]}
        subtitle="Top of the list first. Sorted by priority → blockers → deadline."
        icon={<Target />}
        iconTone="emerald"
        trailing={
          <div className="flex flex-wrap gap-2 text-xs">
            <SummaryPill icon={<ListChecks className="w-3 h-3" />} label="Open" value={mine.length} tone="blue" />
            <SummaryPill icon={<AlertTriangle className="w-3 h-3" />} label="Urgent" value={urgentCount} tone="rose" />
            <SummaryPill icon={<Clock className="w-3 h-3" />} label="Due this week" value={dueWeek} tone="violet" />
            <SummaryPill icon={<Hourglass className="w-3 h-3" />} label="Waiting" value={blocked} tone="indigo" />
          </div>
        }
      />

      {mine.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 grid place-items-center mx-auto mb-3">
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
    </PageStagger>
  );
}

function SummaryPill({
  icon, label, value, tone
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "blue" | "rose" | "violet" | "indigo";
}) {
  const cls = {
    blue: "bg-blue-100/80 text-blue-700 border-blue-200/60",
    rose: "bg-rose-100/80 text-rose-700 border-rose-200/60",
    violet: "bg-indigo-100/80 text-indigo-700 border-indigo-200/60",
    indigo: "bg-indigo-100/80 text-indigo-700 border-indigo-200/60"
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${cls}`}>
      {icon}
      <span className="font-medium">{value}</span>
      <span className="text-ink/60">{label}</span>
    </span>
  );
}
