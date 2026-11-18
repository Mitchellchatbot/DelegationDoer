import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, CalendarDays, MessagesSquare } from "lucide-react";
import { BackPill } from "@/components/BackPill";
import { PersonAvatar } from "@/components/PersonAvatar";
import { StatusPill } from "@/components/Badges";
import { MetaOnboardingPanel } from "@/components/MetaOnboardingPanel";
import { RemoveMetaOnboardingButton } from "@/components/RemoveMetaOnboardingButton";
import { TaskConversation } from "@/components/TaskConversation";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsersLight, getLeaderIds } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canManageTask, canViewTask } from "@/lib/access";
import { canSeeFbOnboarding, getOnboarding, FB_DEPT } from "@/lib/fb-onboarding-data";
import { getMetaOnboarding } from "@/lib/meta-onboarding-data";
import { metaClientName } from "@/lib/meta-onboarding";
import { formatDate } from "@/lib/utils";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

// One client's Meta onboarding. The backing Facebook task keeps the assignee,
// due date and conversation; this page is where the SOP and checklist get
// worked. Access is FB onboarding's rule.
export default async function MetaOnboardingPage({ params }: { params: { id: string } }) {
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

  const [{ ready, onboarding }, fbOnboarding] = await Promise.all([
    getMetaOnboarding(params.id),
    getOnboarding(params.id)
  ]);
  const canEdit = canManageTask(me, task) || (me?.departmentIds ?? []).includes(FB_DEPT);
  const assignee = task.assigneeId ? users.find((u) => u.id === task.assigneeId) ?? null : null;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <BackPill href="/meta-onboarding" label="All Meta onboardings" />
        <div className="flex items-center gap-3 text-xs text-muted flex-wrap">
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
          {fbOnboarding && (
            <Link href={`/fb-onboarding/${t.id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
              FB onboarding <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          )}
          <Link href={`/tasks/${t.id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
            Task &amp; conversation <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
          {onboarding && canManageTask(me, task) && (
            <RemoveMetaOnboardingButton taskId={params.id} client={metaClientName(onboarding.state)} />
          )}
        </div>
      </div>

      {ready ? (
        <MetaOnboardingPanel
          taskId={params.id}
          initialState={onboarding?.state ?? null}
          initialCompletedAt={onboarding?.completedAt ?? null}
          users={users.map((u) => ({ id: u.id, name: u.name }))}
          canEdit={canEdit}
        />
      ) : (
        <div className="card p-6 text-sm">
          <div className="font-medium">Waiting for its database table</div>
          <p className="text-muted mt-1">
            Apply <code className="font-mono text-xs px-1 rounded bg-surface2 border border-border">supabase/migrations/20261119140000_meta_onboarding.sql</code>{" "}
            in the Supabase SQL editor, then reload this page.
          </p>
        </div>
      )}

      {/* Team notes: the task's conversation, so the same thread shows on the
          task page (and on the FB onboarding page, if this task has one). */}
      <section className="card p-5">
        <div className="flex items-center gap-2 mb-1">
          <MessagesSquare className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold">Team notes</h2>
        </div>
        <p className="text-xs text-muted mb-4">Notes and back-and-forth on this client. @mention a teammate to ping them.</p>
        <TaskConversation taskId={params.id} currentUserId={userId} users={users} />
      </section>
    </div>
  );
}
