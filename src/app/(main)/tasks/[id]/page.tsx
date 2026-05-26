import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { PriorityBadge, StatusPill, Tag, StalledBadge } from "@/components/Badges";
import { PersonAvatar } from "@/components/PersonAvatar";
import { TaskActions } from "@/components/TaskActions";
import { TaskTimerButton } from "@/components/TaskTimerButton";
import { NotifyTeammatesDialog } from "@/components/NotifyTeammatesDialog";
import { canNotifyOnTask, canViewTask, canManageTask } from "@/lib/access";
import { getUserById, getAllUsersLight, getDepartments, getLeaderIds } from "@/lib/server-data";
import { Megaphone, Clock, History } from "lucide-react";
import { HandoffButton, HandoffTimeline } from "@/components/HandoffPanel";
import { TaskConversation } from "@/components/TaskConversation";
import { DueDateInline } from "@/components/DueDateInline";
import { TaskFields } from "@/components/TaskFields";
import { MediaGallery } from "@/components/MediaPicker";
import { MarkdownBody } from "@/components/MarkdownBody";
import { requireCurrentUserId } from "@/lib/session";
import { formatDate, relativeTime } from "@/lib/utils";
import { BackPill } from "@/components/BackPill";
import { DepartmentEditor } from "@/components/DepartmentEditor";
import type { Task } from "@/lib/types";

// Always read fresh — comments / status changes need to surface immediately.
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface Extension {
  id: string;
  userId: string;
  previousDueDate: string | null;
  newDueDate: string;
  hoursAdded: number;
  reason: string | null;
  createdAt: string;
}

async function loadTask(id: string): Promise<{ task: Task; extensions: Extension[] } | null> {
  const supabase = getSupabaseAdmin();
  const { data: t, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !t) return null;

  const task: Task = {
    id: t.id,
    title: t.title,
    description: t.description ?? "",
    status: t.status,
    priority: t.priority,
    estimatedHours: Number(t.estimated_hours),
    actualHours:
      t.actual_hours_override !== null && t.actual_hours_override !== undefined
        ? Number(t.actual_hours_override)
        : Number(t.actual_hours ?? 0),
    actualHoursOverride:
      t.actual_hours_override !== null && t.actual_hours_override !== undefined
        ? Number(t.actual_hours_override)
        : null,
    tags: t.tags ?? [],
    departmentId: t.department_id,
    assigneeId: t.assignee_id,
    creatorId: t.creator_id,
    projectId: t.project_id,
    dueDate: t.due_date,
    inactiveFlag: !!t.inactive_flag,
    lastActivityAt: t.last_activity_at,
    createdAt: t.created_at,
    blocksTaskIds: t.blocks_task_ids ?? [],
    clientName: t.client_name ?? null,
    website: t.website ?? null,
    clientEmail: t.client_email ?? null,
    clientFolderUrl: t.client_folder_url ?? null,
    stagingServer: t.staging_server ?? null,
    markupLink: t.markup_link ?? null,
    hostingAccess: t.hosting_access ?? null,
    missiveThreadUrl: t.missive_thread_url ?? null,
    custom: (t.custom as Record<string, unknown> | null) ?? {},
    mediaUrls: Array.isArray(t.media_urls) ? (t.media_urls as Task["mediaUrls"]) : []
  };

  const { data: rawExt } = await supabase
    .from("task_extensions")
    .select("*")
    .eq("task_id", id)
    .order("created_at", { ascending: false });
  const extensions: Extension[] = (rawExt ?? []).map((e) => ({
    id: e.id,
    userId: e.user_id,
    previousDueDate: e.previous_due_date,
    newDueDate: e.new_due_date,
    hoursAdded: Number(e.hours_added),
    reason: e.reason,
    createdAt: e.created_at
  }));
  return { task, extensions };
}

export default async function TaskDetailPage({ params }: { params: { id: string } }) {
  const [loaded, allUsers, currentUserId, departments, leaderIds] = await Promise.all([
    loadTask(params.id),
    getAllUsersLight(),
    requireCurrentUserId(),
    getDepartments(),
    getLeaderIds()
  ]);
  if (!loaded) return notFound();
  const me = await getUserById(currentUserId);
  if (!canViewTask(me, loaded.task, leaderIds)) return notFound();
  const { task, extensions } = loaded;
  const totalHoursAdded = extensions.reduce((s, e) => s + e.hoursAdded, 0);

  const userById = (id: string | null) =>
    id ? allUsers.find((u) => u.id === id) ?? null : null;
  const assignee = userById(task.assigneeId);
  const creator = userById(task.creatorId);
  const dept = task.departmentId ? departments.find((d) => d.id === task.departmentId) ?? null : null;
  const canEditDue = canManageTask(me, task);

  let project: { id: string; name: string } | null = null;
  if (task.projectId) {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("projects")
      .select("id, name")
      .eq("id", task.projectId)
      .maybeSingle();
    if (data) project = { id: data.id, name: data.name };
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <BackPill href="/tasks" label="Back to tasks" />

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <StatusPill status={task.status} />
            <PriorityBadge priority={task.priority} />
            {task.inactiveFlag && <StalledBadge />}
          </div>
          <h1 className="text-xl font-medium">{task.title}</h1>
          <div className="text-xs text-muted mt-1">#{task.id} · created by {creator?.name ?? "—"} · {relativeTime(task.createdAt)}</div>
        </div>
        <div className="flex items-center gap-2">
          <HandoffButton
            taskId={task.id}
            currentAssigneeId={task.assigneeId}
            users={allUsers}
          />
          {canNotifyOnTask(me, task) && (
            <NotifyTeammatesDialog
              taskId={task.id}
              taskDepartmentId={task.departmentId}
              meId={currentUserId}
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-fuchsia-200 bg-fuchsia-50/60 text-fuchsia-700 hover:bg-fuchsia-100 hover:border-fuchsia-300 transition-colors active:scale-95"
                  title="Slack-DM teammates a heads-up with a link to this task"
                >
                  <Megaphone className="w-3.5 h-3.5" />
                  Notify teammates
                </button>
              }
            />
          )}
          <TaskActions task={task} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          {task.description && (
            <section className="card p-4">
              <div className="text-sm font-medium mb-2">Description</div>
              {/* Markdown-rendered. The email-intake classifier emits
                  **Do:** / **Context:** / **Requested by:** sections,
                  and humans writing tasks can use bold / lists / links
                  the same way without seeing raw `**` syntax. */}
              <div className="text-sm text-ink/90">
                <MarkdownBody content={task.description} />
              </div>
              {task.tags.length > 0 && (
                <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                  {task.tags.map((t) => <Tag key={t}>{t}</Tag>)}
                </div>
              )}
            </section>
          )}

          {(task.mediaUrls?.length ?? 0) > 0 && (
            <section className="card p-4">
              <div className="text-sm font-medium mb-3">Attachments</div>
              <MediaGallery items={task.mediaUrls ?? []} />
            </section>
          )}

          <section className="card p-4">
            <div className="text-sm font-medium mb-3">Conversation</div>
            <TaskConversation
              taskId={task.id}
              currentUserId={currentUserId}
              users={allUsers}
            />
          </section>

          {/* Handoff timeline only shows when there's actually been a
              handoff — keeps the page compact for fresh tasks. */}
          <section className="card p-4">
            <div className="text-sm font-medium mb-3 flex items-center gap-2">
              <History className="w-4 h-4 text-accent" />
              Handoff timeline
            </div>
            <HandoffTimeline taskId={task.id} users={allUsers} />
          </section>

          {extensions.length > 0 && (
            <section className="card p-4 border-warn/30 bg-warn/5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium">Deadline extensions</div>
                <div className="text-xs text-muted">
                  {extensions.length} extension{extensions.length === 1 ? "" : "s"} · +{totalHoursAdded}h total
                </div>
              </div>
              <ul className="space-y-3">
                {extensions.map((e) => {
                  const u = userById(e.userId);
                  return (
                    <li key={e.id} className="flex items-start gap-3 text-sm">
                      {u && <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={22} />}
                      <div className="flex-1">
                        <div className="text-ink">
                          <span className="font-medium">{u?.name ?? "—"}</span>{" "}
                          <span className="text-muted">extended by</span>{" "}
                          <span className="text-warn font-medium">+{e.hoursAdded}h</span>
                        </div>
                        <div className="text-xs text-muted mt-0.5">
                          {e.previousDueDate ? formatDate(e.previousDueDate) : "no date"} → <span className="text-ink">{formatDate(e.newDueDate)}</span>
                        </div>
                        {e.reason && (
                          <div className="text-xs text-ink/80 mt-1.5 p-2 rounded-lg bg-surface2 border border-border whitespace-pre-wrap">
                            {e.reason}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-muted">{relativeTime(e.createdAt)}</div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <aside className="card p-4 space-y-4 h-fit">
          <Field label="Assignee">
            {assignee ? (
              <div className="flex items-center gap-2"><PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={22} /> {assignee.name}</div>
            ) : <span className="text-muted">Unassigned</span>}
          </Field>
          <Field label="Department">
            <DepartmentEditor
              taskId={task.id}
              currentId={task.departmentId}
              departments={departments.map((d) => ({ id: d.id, name: d.name }))}
              canEdit={canEditDue}
            />
          </Field>
          {project && (
            <Field label="Project">
              <Link href={`/projects/${project.id}`} className="text-accent hover:underline">{project.name}</Link>
            </Field>
          )}
          {task.clientName && <Field label="Client">{task.clientName}</Field>}
          {task.website && (
            <Field label="Website">
              <a href={task.website.startsWith("http") ? task.website : `https://${task.website}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {task.website}
              </a>
            </Field>
          )}
          <Field label="Estimate">
            <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimatedHours}h</span>
          </Field>
          <Field label="Actual">
            <span className="inline-flex items-center gap-1">
              {Number(task.actualHours ?? 0).toFixed(1)}h
              {task.actualHoursOverride !== null && task.actualHoursOverride !== undefined && (
                <span className="text-[10px] uppercase tracking-wide text-amber-600 ml-1">override</span>
              )}
            </span>
          </Field>
          <Field label="Time">
            <TaskTimerButton taskId={task.id} />
          </Field>
          <Field label="Due">
            <DueDateInline taskId={task.id} initialDueDate={task.dueDate} canEdit={canEditDue} />
            {extensions.length > 0 && (
              <div className="text-[11px] text-warn mt-1">extended +{totalHoursAdded}h ({extensions.length})</div>
            )}
          </Field>
          <Field label="Last activity">{relativeTime(task.lastActivityAt)}</Field>

          {/* Project links + custom fields — collapsed into the Notion-style
              inline-editable block so the sidebar stays compact when nothing's
              filled in. */}
          <div className="pt-3 border-t border-border/60">
            <TaskFields task={task} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
