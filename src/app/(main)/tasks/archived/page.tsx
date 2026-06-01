import Link from "next/link";
import { Archive, Building2, Globe2, CheckCircle2 } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getArchivedTasks, getAllUsersLight, getLeaderIds } from "@/lib/server-data";
import { canViewTask, canManageTask } from "@/lib/access";
import { BackPill } from "@/components/BackPill";
import { PriorityBadge } from "@/components/Badges";
import { PersonAvatar } from "@/components/PersonAvatar";
import { UnarchiveTaskButton } from "@/components/UnarchiveTaskButton";
import { ARCHIVE_AFTER_DAYS } from "@/lib/task-archive";
import { relativeTime, formatDate } from "@/lib/utils";

// Archived tasks view — finished work that's been moved off the active board
// (manually or by the daily auto-archive cron). Everything's intact: status,
// assignee, client, deadline, completion date, history. Anyone may see the
// archived tasks they'd otherwise be allowed to view (same leader-privacy
// rule as the live list); managers get a one-click Unarchive.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ArchivedTasksPage() {
  const currentUserId = await requireCurrentUserId();
  const [me, tasks, users, leaderIds] = await Promise.all([
    getUserById(currentUserId),
    getArchivedTasks(),
    getAllUsersLight(),
    getLeaderIds()
  ]);

  // Same privacy filter the active /api/tasks list applies for non-leaders.
  const visible = tasks.filter((t) => canViewTask(me, t, leaderIds));

  const nameById = (id: string | null | undefined) =>
    id ? users.find((u) => u.id === id) ?? null : null;

  return (
    <div className="space-y-5 max-w-4xl">
      <BackPill href="/tasks/board" label="Back to board" />

      <div>
        <h1 className="text-xl font-medium flex items-center gap-2">
          <Archive className="w-5 h-5 text-amber-500" />
          Archived
        </h1>
        <p className="text-sm text-muted mt-1">
          Completed tasks finished more than {ARCHIVE_AFTER_DAYS} days ago are
          archived automatically to keep the board clean. They&apos;re kept in
          full here — nothing is deleted. Unarchive to bring one back.
        </p>
      </div>

      {visible.length === 0 ? (
        <div className="card p-10 text-center text-sm text-muted">
          Nothing archived yet. 🗂️
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((t) => {
            const assignee = nameById(t.assigneeId);
            const archiver = nameById(t.archivedBy);
            return (
              <div key={t.id} className="card p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <PriorityBadge priority={t.priority} />
                    <Link href={`/tasks/${t.id}`} className="text-sm font-medium truncate hover:underline">
                      {t.title}
                    </Link>
                  </div>
                  <div className="text-xs text-muted mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    {t.completedAt && (
                      <span className="inline-flex items-center gap-1 text-emerald-700/85">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        Completed {formatDate(t.completedAt)}
                      </span>
                    )}
                    {t.archivedAt && <span>· archived {relativeTime(t.archivedAt)}</span>}
                    <span>· {archiver ? `by ${archiver.name}` : "auto"}</span>
                  </div>
                  <div className="text-xs text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {assignee && (
                      <span className="inline-flex items-center gap-1">
                        <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={16} />
                        {assignee.name}
                      </span>
                    )}
                    {t.clientName && (
                      <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{t.clientName}</span>
                    )}
                    {t.website && (
                      <span className="inline-flex items-center gap-1"><Globe2 className="w-3 h-3" />{t.website}</span>
                    )}
                    {t.dueDate && <span>due {formatDate(t.dueDate)}</span>}
                  </div>
                </div>
                {canManageTask(me, t) && (
                  <div className="shrink-0">
                    <UnarchiveTaskButton taskId={t.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
