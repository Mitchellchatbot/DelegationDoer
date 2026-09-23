import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Rocket, AlertTriangle, PartyPopper, Check, Pause, Hourglass, Clock } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { NewFbOnboardingButton } from "@/components/NewFbOnboardingButton";
import { DeleteFbOnboardingButton } from "@/components/DeleteFbOnboardingButton";
import { FbOnboardingNotesButton } from "@/components/FbOnboardingNotesButton";
import { DueDateInline } from "@/components/DueDateInline";
import { canDeleteTask, canManageTask } from "@/lib/access";
import type { User } from "@/lib/types";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsers } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canSeeFbOnboarding, listOnboardings, FB_DEPT, type OnboardingSummary } from "@/lib/fb-onboarding-data";
import { STAGES, STAGE_LABEL, STAGE_BLURB, STAGE_AGING, elapsedDays, type Stage } from "@/lib/fb-onboarding";
import { cn, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Live keeps growing, so only recent hand-overs get a card — but always show
// a few, so the section isn't empty on a slow month.
const LIVE_WINDOW_DAYS = 30;
const LIVE_MIN = 4;

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

  // Grouped by derived stage, not by a stored field: a client lands in the
  // next section the moment the stage before it is fully ticked.
  //
  // Sorted within a section by longest-in-stage first, with anything on hold
  // sunk to the bottom — a parked client shouldn't hold the alarm slot. The
  // query still orders by updated_at, which every key write bumps, so sorting
  // here is what stops toggling a hold from jumping that card to the top.
  const inFlight = onboardings.filter((o) => o.stage !== "live");
  const byStage = (st: Stage) =>
    onboardings
      .filter((o) => o.stage === st)
      .sort((a, b) =>
        Number(a.onHold) - Number(b.onHold) ||
        (b.stageAgeDays ?? 0) - (a.stageAgeDays ?? 0) ||
        (a.startedAt < b.startedAt ? -1 : 1)
      );

  // Live grows without bound, so only the recent ones get cards.
  const live = onboardings
    .filter((o) => o.stage === "live")
    .sort((a, b) => ((b.completedAt ?? "") < (a.completedAt ?? "") ? -1 : 1));
  const liveRecent = live.filter((o) => (elapsedDays(o.completedAt) ?? 0) <= LIVE_WINDOW_DAYS);
  const liveShown = liveRecent.length >= LIVE_MIN ? liveRecent : live.slice(0, LIVE_MIN);
  const liveHidden = live.length - liveShown.length;

  // Needs a nudge. On-hold clients are deliberately left out — that's the
  // whole point of parking one.
  const attention = inFlight
    .filter((o) => !o.onHold && o.taskStatus !== "done")
    .map((o) => {
      const bits: string[] = [];
      if (o.progress.testsFailed > 0) bits.push(`${o.progress.testsFailed} test${o.progress.testsFailed === 1 ? "" : "s"} failing`);
      if (o.progress.blocked > 0) bits.push(`${o.progress.blocked} blocked`);
      if (o.ageBand === "red" && o.stageAgeDays !== null) bits.push(`day ${o.stageAgeDays} in ${STAGE_LABEL[o.stage]}`);
      return { o, reason: bits.join(" · ") };
    })
    .filter((a) => a.reason !== "")
    .sort((a, b) => (b.o.stageAgeDays ?? 0) - (a.o.stageAgeDays ?? 0));

  const waitingClient = inFlight.filter((o) => o.waitingOn === "client").length;
  const onHoldCount = inFlight.filter((o) => o.onHold).length;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHero
        eyebrow="Facebook"
        headline={["Client ", { accent: "onboarding" }]}
        subtitle="Access, launch details, the main zap build, setup and the Typeform test run for every new Facebook client."
        icon={<Rocket />}
        iconTone="violet"
        metaLabel="On the plate:"
        meta={[
          { count: inFlight.length, label: "in flight" },
          { count: attention.length, label: "need a nudge", tone: "rose" as const },
          { count: waitingClient, label: "waiting on the client", tone: "amber" as const },
          { count: onHoldCount, label: "on hold" },
          { count: unstartedTasks.length, label: "FB tasks not started" }
        ].filter((m) => m.count > 0)}
        trailing={<NewFbOnboardingButton people={fbPeople} existingTasks={unstartedTasks} />}
      />

      {onboardings.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          No onboardings yet. Start one with <span className="font-medium text-ink">New onboarding</span> and it appears under{" "}
          <span className="font-medium text-ink">Access</span>, then moves itself along as the checklist gets ticked.
        </div>
      ) : (
        <>
          {attention.length > 0 && (
            <section className="rounded-2xl border border-urgent/30 bg-urgent/[0.04] px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-urgent shrink-0" aria-hidden />
                <h2 className="text-sm font-semibold text-urgent">Needs a nudge</h2>
                <span className="text-xs text-urgent/80 tabular-nums">{attention.length}</span>
                <span className="ml-auto text-[11px] text-muted">Anything on hold is left out.</span>
              </div>
              <ul className="flex flex-wrap gap-2">
                {attention.map(({ o, reason }) => (
                  <li key={o.taskId}>
                    <Link
                      href={`/fb-onboarding/${o.taskId}`}
                      className="inline-flex items-center gap-2 rounded-full border border-urgent/25 bg-surface px-3 py-1.5 text-xs hover:border-urgent/50 transition-colors"
                    >
                      <span className="font-semibold truncate max-w-[16ch]">{o.provider}</span>
                      <span className="text-urgent font-medium whitespace-nowrap">{reason}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="px-1 text-[12px] text-muted">
            Nothing is dragged here — a client moves to the next stage the moment the one before it is fully ticked.
          </p>

          {STAGES.map((st) => {
            const items = st === "live" ? liveShown : byStage(st);
            if (st === "live" && live.length === 0) return null;
            return (
              <Section key={st} stage={st} count={st === "live" ? live.length : items.length}>
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
                    Nothing in {STAGE_LABEL[st].toLowerCase()}.
                  </div>
                ) : (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      {items.map((o) => <OnboardingCard key={o.taskId} o={o} me={me} noteUsers={noteUsers} assignee={o.assigneeId ? userById.get(o.assigneeId) ?? null : null} />)}
                    </div>
                    {st === "live" && liveHidden > 0 && (
                      <p className="mt-2 px-1 text-[11px] text-muted">
                        {liveHidden} more went live earlier than the last {LIVE_WINDOW_DAYS} days.
                      </p>
                    )}
                  </>
                )}
              </Section>
            );
          })}
        </>
      )}
    </div>
  );
}

function Section({ stage: st, count, children }: { stage: Stage; count: number; children: React.ReactNode }) {
  const aging = STAGE_AGING[st];
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-3 px-1">
        <h2 className="text-sm font-semibold">{STAGE_LABEL[st]}</h2>
        <span className="text-xs text-muted tabular-nums">{count}</span>
        <span className="text-[11px] text-muted truncate">{STAGE_BLURB[st]}</span>
        {aging && <span className="ml-auto text-[11px] text-muted shrink-0">over {aging.amber}d is slow</span>}
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
    { label: "Launch", done: p.launchDone, total: p.launchTotal },
    { label: "Main zap", done: p.mainDone, total: p.mainTotal },
    { label: "Setup", done: p.setupDone, total: p.setupTotal },
    { label: "Test", done: p.testsDone, total: p.testsTotal }
  ];

  // A plain card, not a link: it holds a date editor, a note box and a notes
  // panel, and wrapping those in an <a> makes every click a navigation.
  //
  // On hold dims the card with opacity, never `filter`/`grayscale`: those
  // create a containing block for position:fixed and would re-anchor the
  // notes panel and the delete modal into the card.
  return (
    <div className={cn("card p-3 flex flex-col gap-2", o.onHold && "opacity-60 hover:opacity-100 transition-opacity")}>
      <div className="flex items-start justify-between gap-3">
        {/* Name only. The task title underneath was almost always the same
            string again ("fountain hills onboarding" twice) or that string
            with a "Facebook onboarding — " prefix; it still shows in full on
            the onboarding page itself. */}
        <div className="min-w-0">
          <Link href={`/fb-onboarding/${o.taskId}`} className="text-base font-semibold truncate hover:text-accent transition-colors block">
            {o.provider}
          </Link>
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

      {/* Stage age and who the ball is with. Its own row on purpose — in the
          header these compete with the client name and truncate it to
          "Norths…" the moment the waiting note is more than a word. */}
      {(o.stage !== "live" && (o.stageAgeDays !== null || o.onHold || o.waitingOn || p.testsFailed > 0)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {o.stageAgeDays !== null && (
            <span
              title={o.onHold ? "Paused while on hold" : `Day ${o.stageAgeDays} in ${STAGE_LABEL[o.stage]}`}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border tabular-nums",
                o.ageBand === "red" ? "border-urgent/30 bg-urgent/10 text-urgent"
                  : o.ageBand === "amber" ? "border-stalled/40 bg-stalled/10 text-stalled"
                  : "border-border bg-surface2 text-muted"
              )}
            >
              {o.ageBand === "red" || o.ageBand === "amber" ? <Clock className="w-3 h-3" /> : null}
              day {o.stageAgeDays}
            </span>
          )}
          {o.onHold ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-border bg-surface2 text-muted min-w-0">
              <Pause className="w-3 h-3 shrink-0" />
              <span className="truncate">
                On hold{o.holdSince ? ` · ${relativeTime(o.holdSince)}` : ""}{o.holdNote ? ` · ${o.holdNote}` : ""}
              </span>
            </span>
          ) : o.waitingOn ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border min-w-0",
                o.waitingOn === "client" ? "border-stalled/40 bg-stalled/10 text-stalled" : "border-border bg-surface2 text-muted"
              )}
            >
              <Hourglass className="w-3 h-3 shrink-0" />
              <span className="truncate">
                {o.waitingOn === "client" ? "On the client" : "On us"}{o.waitingNote ? ` · ${o.waitingNote}` : ""}
              </span>
            </span>
          ) : null}
          {/* A failing test is the loudest thing a Testing card can say, and
              the header ternary only ever shows one badge. */}
          {p.testsFailed > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-urgent/30 bg-urgent/10 text-urgent">
              <AlertTriangle className="w-3 h-3" /> {p.testsFailed} test{p.testsFailed === 1 ? "" : "s"} failing
            </span>
          )}
        </div>
      )}

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

      <div className="grid grid-cols-5 gap-2">
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

      {/* No inline composer. The notes button in the corner opens the full
          thread, which already has one — an always-open input on every card
          was ~50px of the card's height to duplicate something one click
          away. */}

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
