import Link from "next/link";
import { notFound } from "next/navigation";
import { tasks as mockTasks, userById, deptById, projectById, activity as mockActivity } from "@/lib/mock-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { PriorityBadge, StatusPill, Tag, StalledBadge } from "@/components/Badges";
import { Avatar } from "@/components/Avatar";
import { Countdown } from "@/components/Countdown";
import { TaskActions, CommentForm } from "@/components/TaskActions";
import { formatDate, relativeTime } from "@/lib/utils";
import { ArrowLeft, Clock, Calendar } from "lucide-react";
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
        blocksTaskIds: t.blocks_task_ids ?? [],
        clientName: t.client_name ?? null,
        website: t.website ?? null
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
  const loaded = await loadTask(params.id);
  if (!loaded) return notFound();
  const { task, log, extensions } = loaded;
  const totalHoursAdded = extensions.reduce((s, e) => s + e.hoursAdded, 0);

  const assignee = userById(task.assigneeId);
  const creator = userById(task.creatorId);
  const dept = deptById(task.departmentId);
  const project = projectById(task.projectId);

  return (
    <div className="space-y-5 max-w-5xl">
      <Link href="/tasks" className="text-xs text-muted hover:text-ink inline-flex items-center gap-1">
        <ArrowLeft className="w-3 h-3" /> Back to tasks
      </Link>

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
        <TaskActions task={task} />
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
                    {u && <Avatar name={u.name} size={22} />}
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
                      {u && <Avatar name={u.name} size={22} />}
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
              <div className="flex items-center gap-2"><Avatar name={assignee.name} size={22} /> {assignee.name}</div>
            ) : <span className="text-muted">Unassigned</span>}
          </Field>
          <Field label="Department">{dept?.name ?? "—"}</Field>
          <Field label="Project">{project ? <Link href={`/projects/${project.id}`} className="text-accent hover:underline">{project.name}</Link> : "—"}</Field>
          <Field label="Client">{task.clientName || <span className="text-muted">internal</span>}</Field>
          <Field label="Website">{task.website
            ? <a href={task.website.startsWith("http") ? task.website : `https://${task.website}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{task.website}</a>
            : "—"}</Field>
          <Field label="Estimate"><span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{task.estimatedHours}h</span></Field>
          <Field label="Actual">{task.actualHours}h</Field>
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
