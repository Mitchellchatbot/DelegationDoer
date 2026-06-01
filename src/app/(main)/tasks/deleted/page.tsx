import { notFound } from "next/navigation";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getDeletedTasks, getAllUsersLight } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";
import { BackPill } from "@/components/BackPill";
import { PriorityBadge } from "@/components/Badges";
import { RestoreTaskButton } from "@/components/RestoreTaskButton";
import { relativeTime } from "@/lib/utils";

// Admin-only recovery view: every soft-deleted task, newest first, with the
// reason captured at delete time and a one-click restore. Satisfies the
// "recoverable by admins / retained for audit" requirement.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DeletedTasksPage() {
  const currentUserId = await requireCurrentUserId();
  const me = await getUserById(currentUserId);
  if (!isLeader(me)) return notFound();

  const [tasks, users] = await Promise.all([getDeletedTasks(), getAllUsersLight()]);
  const nameById = (id: string | null | undefined) =>
    id ? users.find((u) => u.id === id)?.name ?? "—" : "—";

  // Pull the latest deletion reason per task from the audit table.
  const reasonByTask = new Map<string, string>();
  if (tasks.length > 0) {
    const { data: audits } = await getSupabaseAdmin()
      .from("task_deletions")
      .select("task_id, reason, created_at")
      .in("task_id", tasks.map((t) => t.id))
      .order("created_at", { ascending: false });
    for (const a of (audits ?? []) as { task_id: string | null; reason: string | null }[]) {
      if (a.task_id && a.reason && !reasonByTask.has(a.task_id)) {
        reasonByTask.set(a.task_id, a.reason);
      }
    }
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <BackPill href="/tasks/board" label="Back to board" />

      <div>
        <h1 className="text-xl font-medium flex items-center gap-2">
          <Trash2 className="w-5 h-5 text-rose-500" />
          Recently deleted
        </h1>
        <p className="text-sm text-muted mt-1">
          Soft-deleted tasks are hidden everywhere else but kept here for audit
          and recovery. Restoring brings a task back into normal views.
        </p>
      </div>

      {tasks.length === 0 ? (
        <div className="card p-10 text-center text-sm text-muted">
          No deleted tasks. 🎉
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => {
            const reason = reasonByTask.get(t.id);
            return (
              <div key={t.id} className="card p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <PriorityBadge priority={t.priority} />
                    <span className="text-sm font-medium truncate">{t.title}</span>
                  </div>
                  <div className="text-xs text-muted mt-1">
                    #{t.id} · deleted by {nameById(t.deletedBy)}
                    {t.deletedAt && <> · {relativeTime(t.deletedAt)}</>}
                  </div>
                  {reason && (
                    <div className="text-xs text-muted mt-1">
                      Reason: <span className="text-ink">{reason}</span>
                    </div>
                  )}
                  {t.missiveThreadUrl && (
                    <div className="text-xs text-muted mt-1">
                      <Link href={t.missiveThreadUrl} className="text-accent hover:underline" target="_blank">
                        Originating email thread →
                      </Link>{" "}
                      (unaffected)
                    </div>
                  )}
                </div>
                <div className="shrink-0">
                  <RestoreTaskButton taskId={t.id} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
