import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Rocket, AlertTriangle, PartyPopper, Check } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { NewFbOnboardingButton } from "@/components/NewFbOnboardingButton";
import { DeleteFbOnboardingButton } from "@/components/DeleteFbOnboardingButton";
import { FbOnboardingNotesButton } from "@/components/FbOnboardingNotesButton";
import { FbOnboardingNoteComposer } from "@/components/FbOnboardingNoteComposer";
import { DueDateInline } from "@/components/DueDateInline";
import { canDeleteTask, canManageTask } from "@/lib/access";
import type { User } from "@/lib/types";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsers } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canSeeFbOnboarding, listOnboardings, FB_DEPT, type OnboardingSummary } from "@/lib/fb-onboarding-data";
import { cn, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function FbOnboardingListPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  if (!canSeeFbOnboarding(me)) return notFound();

  const [onboardings, users, { data: fbTasks }] = await Promise.all([
    listOnboardings(),
    getAllUsers(),
    getSupabaseAdmin()
      .from("tasks")
      .select("id, title")
      .eq("department_id", FB_DEPT)
      .is("deleted_at", null)
      .is("archived_at", null)
      .neq("status", "done")
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  const started = new Set(onboardings.map((o) => o.taskId));
  const unstartedTasks = (fbTasks ?? [])
    .filter((t) => !started.has(t.id as string))
    .map((t) => ({ id: t.id as string, title: t.title as string }));
  const fbPeople = users
    .filter((u) => (u.departmentIds ?? []).includes(FB_DEPT))
    .map((u) => ({ id: u.id, name: u.name }));
  const userById = new Map(users.map((u) => [u.id, u]));
  const noteUsers = users.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null, email: u.email ?? null, role: u.role }));

  const active = onboardings.filter((o) => !o.completedAt);
  const done = onboardings.filter((o) => o.completedAt);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHero
        eyebrow="Facebook"
        headline={["Client ", { accent: "onboarding" }]}
        subtitle="Access, the main zap build, setup and the Typeform test run for every new Facebook client."
        icon={<Rocket />}
        iconTone="violet"
        trailing={<NewFbOnboardingButton people={fbPeople} existingTasks={unstartedTasks} />}
      />

      <Section title="In progress" count={active.length}>
        {active.length === 0 ? (
          <div className="card p-8 text-center text-sm text-muted">No onboardings in progress. Start one with <span className="font-medium text-ink">New onboarding</span>.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {active.map((o) => <OnboardingCard key={o.taskId} o={o} me={me} noteUsers={noteUsers} assignee={o.assigneeId ? userById.get(o.assigneeId) ?? null : null} />)}
          </div>
        )}
      </Section>

      {done.length > 0 && (
        <Section title="Complete" count={done.length}>
          <div className="grid gap-3 md:grid-cols-2">
            {done.map((o) => <OnboardingCard key={o.taskId} o={o} me={me} noteUsers={noteUsers} assignee={o.assigneeId ? userById.get(o.assigneeId) ?? null : null} />)}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2 px-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted">{count}</span>
      </div>
      {children}
    </section>
  );
}

type NoteUser = { id: string; name: string; avatarUrl: string | null; email: string | null; role: string };

const ACCESS_TAG: Record<string, string> = {
  cleared: "border-ok/30 bg-ok/10 text-ok",
  blocked: "border-urgent/30 bg-urgent/10 text-urgent",
  in_progress: "border-accent/25 bg-accent/5 text-accent",
  not_started: "border-border bg-surface2 text-muted"
};

function OnboardingCard({ o, me, noteUsers, assignee }: {
  o: OnboardingSummary;
  me: User;
  noteUsers: NoteUser[];
  assignee: { id: string; name: string; avatarUrl?: string | null } | null;
}) {
  const p = o.progress;
  const taskShape = { creatorId: o.creatorId ?? "", assigneeId: o.assigneeId, departmentId: FB_DEPT };
  const canEdit = canManageTask(me, taskShape);
  const nameOf = (id: string | null) => (id ? noteUsers.find((u) => u.id === id)?.name ?? "Someone" : "Someone");
  const hidden = o.noteCount - o.notes.length;
  const phases = [
    { label: "Access", done: p.accessCleared, total: p.accessTotal },
    { label: "Main zap", done: p.mainDone, total: p.mainTotal },
    { label: "Setup", done: p.setupDone, total: p.setupTotal },
    { label: "Test", done: p.testsDone, total: p.testsTotal }
  ];

  // A plain card, not a link: it holds a date editor, a note box and a notes
  // panel, and wrapping those in an <a> makes every click a navigation.
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/fb-onboarding/${o.taskId}`} className="text-base font-semibold truncate hover:text-accent transition-colors block">
            {o.provider}
          </Link>
          <div className="text-xs text-muted truncate">{o.taskTitle}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {o.completedAt ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-ok/30 bg-ok/10 text-ok">
              <PartyPopper className="w-3 h-3" /> Complete
            </span>
          ) : p.blocked > 0 ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-urgent/30 bg-urgent/10 text-urgent">
              <AlertTriangle className="w-3 h-3" /> {p.blocked} blocked
            </span>
          ) : null}
          {assignee && <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={24} />}
          <FbOnboardingNotesButton
            taskId={o.taskId}
            provider={o.provider}
            count={o.noteCount}
            currentUserId={me.id}
            users={noteUsers}
          />
          <DeleteFbOnboardingButton
            variant="icon"
            taskId={o.taskId}
            provider={o.provider}
            canDeleteTask={canDeleteTask(me, taskShape)}
            canRemoveChecklist={canEdit}
          />
        </div>
      </div>

      {/* Access at a glance — the same six items as the Access tab. */}
      <div className="flex flex-wrap gap-1.5">
        {o.access.map((a) => (
          <span
            key={a.id}
            title={`${a.label}: ${a.status.replace("_", " ")}`}
            className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border", ACCESS_TAG[a.status])}
          >
            {a.status === "cleared" && <Check className="w-3 h-3" />}
            {a.status === "blocked" && <AlertTriangle className="w-3 h-3" />}
            {a.label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2">
        {phases.map((ph) => {
          const full = ph.done === ph.total;
          return (
            <div key={ph.label}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted">{ph.label}</span>
                <span className={cn(full ? "text-ok" : "text-ink")}>{ph.done}/{ph.total}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface2 overflow-hidden">
                <div className={cn("h-full rounded-full", full ? "bg-ok" : "bg-accent")} style={{ width: `${(ph.done / Math.max(ph.total, 1)) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {o.notes.length > 0 && (
        <div className="rounded-lg bg-surface2/70 px-2.5 py-1.5 max-h-36 overflow-y-auto space-y-1.5">
          {hidden > 0 && (
            <div className="text-[11px] text-muted">{hidden} earlier note{hidden === 1 ? "" : "s"} — open the notes panel to read them</div>
          )}
          {o.notes.map((n) => (
            <div key={n.id} className="flex items-start gap-2 text-xs">
              <span className="font-medium shrink-0">{nameOf(n.userId)}</span>
              <span className="text-ink/80 flex-1 min-w-0 whitespace-pre-wrap break-words">{n.text}</span>
              <span className="text-[11px] text-muted shrink-0">{relativeTime(n.at)}</span>
            </div>
          ))}
        </div>
      )}

      <FbOnboardingNoteComposer taskId={o.taskId} />

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/60 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="uppercase tracking-wide">Go-live</span>
          <DueDateInline taskId={o.taskId} initialDueDate={o.dueDate} canEdit={canEdit} />
        </span>
        <span className="truncate">Updated {relativeTime(o.updatedAt)}{assignee ? ` · ${assignee.name}` : ""}</span>
      </div>
    </div>
  );
}
