import Link from "next/link";
import { notFound } from "next/navigation";
import { tasks as mockTasks, userById, deptById, projectById, activity as mockActivity } from "@/lib/mock-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { PriorityBadge, StatusPill, Tag, StalledBadge } from "@/components/Badges";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { Countdown } from "@/components/Countdown";
import { TaskActions, CommentForm } from "@/components/TaskActions";
import { TaskTimerButton } from "@/components/TaskTimerButton";
import { NotifyTeammatesDialog } from "@/components/NotifyTeammatesDialog";
import { canNotifyOnTask } from "@/lib/access";
import { getUserById } from "@/lib/server-data";
import { Megaphone } from "lucide-react";
import { HandoffButton, HandoffTimeline } from "@/components/HandoffPanel";
import { TaskThread } from "@/components/TaskThread";
import { TaskFields } from "@/components/TaskFields";
import { getAllUsersLight } from "@/lib/server-data";
import { requireCurrentUserId } from "@/lib/session";
import { formatDate, relativeTime } from "@/lib/utils";
import { Clock, Calendar, MessageCircle, History } from "lucide-react";
import { BackPill } from "@/components/BackPill";
import type { Task, ActivityLog } from "@/lib/types";

// Always read fresh — comments / status changes need to surface immediately.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Server component. Tasks are sourced from Supabase first (so newly-created
// rows from the New Task form show up); falls back to in-memory mock-data
// for the seeded set in case Supabase isn't reachable.

interface Extension {
  id: string;
  userId: string;
  previousDueDate: string | null;
  newDueDate: string;
  hoursAdded: number;
  reason: string | null;
  createdAt: string;
}

async function loadTask(id: string): Promise<{ task: Task; log: ActivityLog[]; extensions: Extension[] } | null> {
  // Try Supabase first.
  try {
    const supabase = getSupabaseAdmin();
    const { data: t, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (!error && t) {
      const task: Task = {
        id: t.id,
        title: t.title,
        description: t.description ?? "",
        status: t.status,
        priority: t.priority,
        estimatedHours: Number(t.estimated_hours),
        // Override wins over the time_entries-derived denorm. Matches the
        // override-precedence rule in src/lib/server-data.ts.
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
        custom: (t.custom as Record<string, unknown> | null) ?? {}
      };

      const [{ data: rawLog }, { data: rawExt }] = await Promise.all([
        supabase.from("activity_logs").select("*").eq("task_id", id).order("created_at", { ascending: false }),
        supabase.from("task_extensions").select("*").eq("task_id", id).order("created_at", { ascending: false })
      ]);

      const log: ActivityLog[] = (rawLog ?? []).map((a) => ({
        id: a.id,
        taskId: a.task_id,
        userId: a.user_id,
        action: a.action,
        detail: a.detail ?? "",
        imageUrl: a.image_url ?? null,
        createdAt: a.created_at
      }));
      const extensions: Extension[] = (rawExt ?? []).map((e) => ({
        id: e.id,
        userId: e.user_id,
        previousDueDate: e.previous_due_date,
        newDueDate: e.new_due_date,
        hoursAdded: Number(e.hours_added),
        reason: e.reason,
        createdAt: e.created_at
      }));
      return { task, log, extensions };
    }
  } catch { /* fall through to mock */ }

  // Fallback for the seeded data when Supabase isn't reachable.
  const m = mockTasks.find((t) => t.id === id);
  if (!m) return null;
  const log = mockActivity
    .filter((a) => a.taskId === id)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return { task: m, log, extensions: [] };
}

export default async function TaskDetailPage({ params }: { params: { id: string } }) {
  const [loaded, allUsers, currentUserId] = await Promise.all([
    loadTask(params.id),
    getAllUsersLight(),
    requireCurrentUserId()
  ]);
  if (!loaded) return notFound();
  // Fetch the current user's full record (incl. departmentIds) so the
  // access helper has a real shape to evaluate.
  const me = await getUserById(currentUserId);
  const { task, log, extensions } = loaded;
  const totalHoursAdded = extensions.reduce((s, e) => s + e.hoursAdded, 0);

  // Prefer the live users list for the assignee/creator labels so renames
  // surface immediately; fall back to the mock-data lookup if a user has
  // been deleted (orphan reference).
  const userFromAll = (id: string | null) =>
    id ? allUsers.find((u) => u.id === id) ?? userById(id) ?? null : null;
  const assignee = userFromAll(task.assigneeId);
  const creator = userFromAll(task.creatorId);
  const dept = deptById(task.departmentId);
  const project = projectById(task.projectId);

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
          <section className="card p-4">
            <div className="text-sm font-medium mb-2">Description</div>
            <p className="text-sm text-ink/90 whitespace-pre-wrap">{task.description}</p>
            <div className="mt-3 flex items-center gap-1.5 flex-wrap">
              {task.tags.map((t) => <Tag key={t}>{t}</Tag>)}
            </div>
          </section>

          <section className="card p-4">
            <div className="text-sm font-medium mb-3">Activity log</div>
            <ul className="space-y-3">
              {log.map((a) => {
                const u = userById(a.userId);
                return (
                  <li key={a.id} className="flex items-start gap-3 text-sm">
                    {u && <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={22} />}
                    <div className="flex-1 min-w-0">
                      <div className="text-ink">
                        <span className="font-medium">{u?.name ?? "—"}</span>{" "}
                        <span className="text-muted">{a.action.replace("_", " ")}</span>
                      </div>
                      {a.detail && (
                        <div className="text-muted text-xs mt-0.5 whitespace-pre-wrap">{a.detail}</div>
                      )}
                      {a.imageUrl && (
                        <a href={a.imageUrl} target="_blank" rel="noreferrer" className="block mt-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={a.imageUrl}
                            alt="attachment"
                            className="rounded-lg border border-border max-h-48 hover:opacity-90 transition-opacity"
                          />
                        </a>
                      )}
                    </div>
                    <div className="text-xs text-muted shrink-0">{relativeTime(a.createdAt)}</div>
                  </li>
                );
              })}
              {log.length === 0 && <div className="text-sm text-muted">No activity yet.</div>}
            </ul>
            <CommentForm taskId={task.id} />
          </section>

          <section className="card p-4">
            <div className="text-sm font-medium mb-3 flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-accent" />
              Thread
            </div>
            <TaskThread taskId={task.id} users={allUsers} currentUserId={currentUserId} />
          </section>

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
          <Field label="Department">{dept?.name ?? "—"}</Field>
          <Field label="Project">{project ? <Link href={`/projects/${project.id}`} className="text-accent hover:underline">{project.name}</Link> : "—"}</Field>
          <Field label="Client">{task.clientName || <span className="text-muted">internal</span>}</Field>
          <Field label="Website">{task.website
            ? <a href={task.website.startsWith("http") ? task.website : `https://${task.website}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{task.website}</a>
            : "—"}</Field>
          <Field label="Estimate"><span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimatedHours}h</span></Field>
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
            <div className="space-y-0.5">
              <div className="inline-flex items-center gap-1">
                <Calendar className="w-3 h-3 text-muted" />
                <Countdown iso={task.dueDate} />
              </div>
              {task.dueDate && (
                <div className="text-[11px] text-muted">
                  {new Date(task.dueDate).toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    timeZoneName: "short"
                  })}
                </div>
              )}
              {extensions.length > 0 && (
                <div className="text-[11px] text-warn">extended +{totalHoursAdded}h ({extensions.length})</div>
              )}
            </div>
          </Field>
          <Field label="Last activity">{relativeTime(task.lastActivityAt)}</Field>

          {/* Project links + custom fields. Renders the Notion-style block
              of inline-editable rows: client email, folder, staging URL,
              etc., plus whatever the team has defined under Settings →
              Custom fields. */}
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
