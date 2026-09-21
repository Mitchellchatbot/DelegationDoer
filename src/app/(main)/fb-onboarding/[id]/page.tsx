import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, CalendarDays } from "lucide-react";
import { BackPill } from "@/components/BackPill";
import { PersonAvatar } from "@/components/PersonAvatar";
import { StatusPill } from "@/components/Badges";
import { FbOnboardingPanel } from "@/components/FbOnboardingPanel";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsersLight, getLeaderIds } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canManageTask, canViewTask } from "@/lib/access";
import { canSeeFbOnboarding, getOnboarding, FB_DEPT } from "@/lib/fb-onboarding-data";
import { formatDate } from "@/lib/utils";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

// The onboarding workspace for one Facebook client. The backing task keeps
// the assignee, due date and conversation; this page is where the checklist
// actually gets worked.
export default async function FbOnboardingPage({ params }: { params: { id: string } }) {
  const userId = await requireCurrentUserId();
  const [me, leaderIds, users, { data: t }] = await Promise.all([
    getUserById(userId),
    getLeaderIds(),
    getAllUsersLight(),
    getSupabaseAdmin()
      .from("tasks")
      .select("id, title, status, department_id, assignee_id, creator_id, tags, due_date, deleted_at")
      .eq("id", params.id)
      .maybeSingle()
  ]);
  if (!t || t.deleted_at || t.department_id !== FB_DEPT) return notFound();

  const task = {
    creatorId: t.creator_id as string,
    assigneeId: (t.assignee_id as string | null) ?? null,
    departmentId: t.department_id as string,
    tags: (t.tags as string[] | null) ?? [],
    status: t.status as Task["status"]
  };
  if (!canSeeFbOnboarding(me) && !canViewTask(me, task, leaderIds)) return notFound();

  const onboarding = await getOnboarding(params.id);
  const canEdit = canManageTask(me, task) || (me?.departmentIds ?? []).includes(FB_DEPT);
  const assignee = task.assigneeId ? users.find((u) => u.id === task.assigneeId) ?? null : null;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <BackPill href="/fb-onboarding" label="All onboardings" />
        <div className="flex items-center gap-3 text-xs text-muted">
          <StatusPill status={task.status} />
          {assignee && (
            <span className="inline-flex items-center gap-1.5">
              <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={20} />
              {assignee.name}
            </span>
          )}
          {t.due_date && (
            <span className="inline-flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" /> Go-live {formatDate(t.due_date as string)}</span>
          )}
          <Link href={`/tasks/${t.id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
            Task &amp; conversation <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      <FbOnboardingPanel
        taskId={params.id}
        initialState={onboarding?.state ?? null}
        initialCompletedAt={onboarding?.completedAt ?? null}
        users={users.map((u) => ({ id: u.id, name: u.name }))}
        canEdit={canEdit}
      />
    </div>
  );
}
