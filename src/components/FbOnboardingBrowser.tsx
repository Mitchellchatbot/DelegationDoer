"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, PartyPopper, Check, Pause, Hourglass, Clock, ChevronLeft, ChevronRight
} from "lucide-react";
import { PersonAvatar } from "@/components/PersonAvatar";
import { DeleteFbOnboardingButton } from "@/components/DeleteFbOnboardingButton";
import { FbOnboardingNotesButton } from "@/components/FbOnboardingNotesButton";
import { DueDateInline } from "@/components/DueDateInline";
import { PriorityInline } from "@/components/PriorityInline";
import { AccessQuickFields } from "@/components/AccessQuickFields";
import { canDeleteTask, canManageTask } from "@/lib/access";
import { STAGE_LABEL, STAGE_BLURB, type Stage } from "@/lib/fb-onboarding";
import type { OnboardingSummary } from "@/lib/fb-onboarding-data";
import type { User } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

// One client at a time. The strip across the top is every onboarding in
// stage order; the card below is whichever is selected, using the full page
// width instead of a two-up grid of cramped cards.
//
// Moving between clients: click a chip, the arrows either side of the name,
// the ← / → keys, or a swipe on a touchpad / phone.

const FB_DEPT = "dep_facebook";

type NoteUser = { id: string; name: string; avatarUrl: string | null; email: string | null; role: string };
type AssigneeLite = { id: string; name: string; avatarUrl?: string | null };

const ACCESS_TAG: Record<string, string> = {
  cleared: "border-ok/30 bg-ok/10 text-ok",
  blocked: "border-urgent/30 bg-urgent/10 text-urgent",
  in_progress: "border-accent/25 bg-accent/5 text-accent",
  not_started: "border-border bg-surface2 text-muted"
};

const STAGE_DOT: Record<Stage, string> = {
  access: "bg-slate-400",
  launch: "bg-violet-500",
  sync: "bg-sky-500",
  main: "bg-accent",
  setup: "bg-indigo-500",
  test: "bg-amber-500",
  live: "bg-ok"
};

export function FbOnboardingBrowser({
  onboardings, me, noteUsers, assignees
}: {
  onboardings: OnboardingSummary[];
  me: User;
  noteUsers: NoteUser[];
  assignees: Record<string, AssigneeLite>;
}) {
  const [index, setIndex] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);

  const count = onboardings.length;
  const current = onboardings[Math.min(index, count - 1)];

  const go = useCallback((next: number) => {
    if (count === 0) return;
    setIndex(((next % count) + count) % count);
  }, [count]);

  // Arrow keys, unless the user is typing into one of the card's fields.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); go(index - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); go(index + 1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index]);

  // Keep the selected chip in view as the selection moves.
  useEffect(() => {
    const strip = stripRef.current;
    const chip = strip?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
    chip?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [index]);

  if (count === 0 || !current) return null;

  const stageRuns = runs(onboardings);

  return (
    <div className="space-y-4">
      {/* The strip: every client, grouped under its stage, scrolling sideways. */}
      <div
        ref={stripRef}
        className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x"
        role="tablist"
        aria-label="Clients"
      >
        {stageRuns.map((run) => (
          <div key={run.stage} className="flex flex-col gap-1.5 shrink-0">
            <div className="flex items-center gap-1.5 px-1">
              <span className={cn("w-1.5 h-1.5 rounded-full", STAGE_DOT[run.stage])} />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted whitespace-nowrap">
                {STAGE_LABEL[run.stage]}
              </span>
              <span className="text-[11px] text-muted tabular-nums">{run.items.length}</span>
            </div>
            <div className="flex gap-1.5">
              {run.items.map(({ o, idx }) => {
                const active = idx === index;
                const hot = !o.onHold && (o.ageBand === "red" || o.progress.testsFailed > 0 || o.progress.blocked > 0);
                return (
                  <button
                    key={o.taskId}
                    data-idx={idx}
                    role="tab"
                    aria-selected={active}
                    onClick={() => go(idx)}
                    className={cn(
                      "snap-start shrink-0 rounded-xl border px-3 py-2 text-left transition-colors",
                      active ? "border-accent bg-accent/10" : "border-border bg-surface hover:bg-surface2",
                      o.onHold && !active && "opacity-60"
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={cn("text-sm font-semibold truncate max-w-[18ch]", active && "text-accent")}>
                        {o.provider}
                      </span>
                      {hot && <span className="w-1.5 h-1.5 rounded-full bg-urgent shrink-0" aria-label="needs attention" />}
                      {o.onHold && <Pause className="w-3 h-3 text-muted shrink-0" />}
                    </div>
                    <div className="text-[11px] text-muted tabular-nums">
                      {o.stage === "live"
                        ? "live"
                        : o.stageAgeDays !== null ? `day ${o.stageAgeDays}` : "—"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* The card. Swiping anywhere on it moves to the next / previous client. */}
      <div
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          touchX.current = null;
          const end = e.changedTouches[0]?.clientX;
          if (start == null || end == null) return;
          const dx = end - start;
          if (Math.abs(dx) > 60) go(index + (dx < 0 ? 1 : -1));
        }}
      >
        <OnboardingDetail
          o={current}
          me={me}
          noteUsers={noteUsers}
          assignee={current.assigneeId ? assignees[current.assigneeId] ?? null : null}
          position={`${index + 1} of ${count}`}
          onPrev={() => go(index - 1)}
          onNext={() => go(index + 1)}
        />
      </div>
    </div>
  );
}

// Consecutive clients sharing a stage, keeping each one's index in the flat
// list so selection and the arrows stay simple.
function runs(list: OnboardingSummary[]) {
  const out: { stage: Stage; items: { o: OnboardingSummary; idx: number }[] }[] = [];
  list.forEach((o, idx) => {
    const last = out[out.length - 1];
    if (last && last.stage === o.stage) last.items.push({ o, idx });
    else out.push({ stage: o.stage, items: [{ o, idx }] });
  });
  return out;
}

function OnboardingDetail({
  o, me, noteUsers, assignee, position, onPrev, onNext
}: {
  o: OnboardingSummary;
  me: User;
  noteUsers: NoteUser[];
  assignee: AssigneeLite | null;
  position: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const p = o.progress;
  const taskShape = { creatorId: o.creatorId ?? "", assigneeId: o.assigneeId, departmentId: FB_DEPT };
  const canEdit = canManageTask(me, taskShape);
  const nameOf = (id: string | null) => (id ? noteUsers.find((u) => u.id === id)?.name ?? "Someone" : "Someone");
  const hidden = o.noteCount - o.notes.length;
  const phases = useMemo(() => ([
    { label: "Access", done: p.accessCleared, total: p.accessTotal },
    { label: "Launch", done: p.launchDone, total: p.launchTotal },
    { label: "Scaled Sync", done: p.syncDone, total: p.syncTotal },
    { label: "Main zap", done: p.mainDone, total: p.mainTotal },
    { label: "Setup", done: p.setupDone, total: p.setupTotal },
    { label: "Test", done: p.testsDone, total: p.testsTotal }
  ]), [p]);

  return (
    <section className={cn("card p-5", o.onHold && "bg-surface2/40")}>
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <NavButton onClick={onPrev} label="Previous client"><ChevronLeft className="w-4 h-4" /></NavButton>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Link href={`/fb-onboarding/${o.taskId}`} className="text-2xl font-bold truncate hover:text-accent transition-colors">
                {o.provider}
              </Link>
              <PriorityInline taskId={o.taskId} initialPriority={o.priority} canEdit={canEdit} />
            </div>
            <div className="text-xs text-muted mt-0.5 flex items-center gap-1.5">
              <span className={cn("w-1.5 h-1.5 rounded-full", STAGE_DOT[o.stage])} />
              <span className="font-medium text-ink/70">{STAGE_LABEL[o.stage]}</span>
              <span className="truncate">{STAGE_BLURB[o.stage]}</span>
            </div>
          </div>
          <NavButton onClick={onNext} label="Next client"><ChevronRight className="w-4 h-4" /></NavButton>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-muted tabular-nums">{position}</span>
          {o.completedAt ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-ok/30 bg-ok/10 text-ok">
              <PartyPopper className="w-3 h-3" /> Complete
            </span>
          ) : null}
          {assignee && <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={26} />}
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
      </header>

      {/* Status chips: how long in this stage, who the ball is with, failures. */}
      {(o.stage !== "live" && (o.stageAgeDays !== null || o.onHold || o.waitingOn || p.testsFailed > 0 || p.blocked > 0)) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
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
              {(o.ageBand === "red" || o.ageBand === "amber") && <Clock className="w-3 h-3" />}
              day {o.stageAgeDays}
            </span>
          )}
          {o.onHold ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-border bg-surface2 text-muted">
              <Pause className="w-3 h-3 shrink-0" />
              On hold{o.holdSince ? ` · ${relativeTime(o.holdSince)}` : ""}{o.holdNote ? ` · ${o.holdNote}` : ""}
            </span>
          ) : o.waitingOn ? (
            <span className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border",
              o.waitingOn === "client" ? "border-stalled/40 bg-stalled/10 text-stalled" : "border-border bg-surface2 text-muted"
            )}>
              <Hourglass className="w-3 h-3 shrink-0" />
              {o.waitingOn === "client" ? "On the client" : "On us"}{o.waitingNote ? ` · ${o.waitingNote}` : ""}
            </span>
          ) : null}
          {p.blocked > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-urgent/30 bg-urgent/10 text-urgent">
              <AlertTriangle className="w-3 h-3" /> {p.blocked} blocked
            </span>
          )}
          {p.testsFailed > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-urgent/30 bg-urgent/10 text-urgent">
              <AlertTriangle className="w-3 h-3" /> {p.testsFailed} test{p.testsFailed === 1 ? "" : "s"} failing
            </span>
          )}
        </div>
      )}

      {/* Progress across all six phases, full width. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
        {phases.map((ph) => {
          const full = ph.done === ph.total;
          return (
            <Link key={ph.label} href={`/fb-onboarding/${o.taskId}`} className="group">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted group-hover:text-accent transition-colors">{ph.label}</span>
                <span className={cn("tabular-nums", full ? "text-ok" : "text-ink")}>{ph.done}/{ph.total}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-surface2 overflow-hidden">
                <div className={cn("h-full rounded-full", full ? "bg-ok" : "bg-accent")} style={{ width: `${(ph.done / Math.max(ph.total, 1)) * 100}%` }} />
              </div>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mt-5">
        <div className="space-y-4">
          <div>
            <div className="label">Access</div>
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
          </div>

          <div className="rounded-xl bg-urgent/5 border border-urgent/20 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted">Go-live</div>
            <div className="flex items-center gap-1.5 text-lg font-bold text-urgent leading-tight">
              <DueDateInline taskId={o.taskId} initialDueDate={o.dueDate} canEdit={canEdit} />
            </div>
          </div>

          <AccessQuickFields taskId={o.taskId} state={o.state} canEdit={canEdit} />
        </div>

        <div className="flex flex-col min-h-0">
          <div className="label">Team notes</div>
          {o.notes.length > 0 ? (
            <div className="rounded-xl bg-surface2/70 px-3 py-2 space-y-1.5 overflow-y-auto max-h-[22rem]">
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
          ) : (
            <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
              No notes yet — the speech-bubble button up top opens the thread.
            </div>
          )}
          <div className="mt-2 text-[11px] text-muted">
            Updated {relativeTime(o.updatedAt)}{assignee ? ` · ${assignee.name}` : ""}
          </div>
        </div>
      </div>
    </section>
  );
}

function NavButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={`${label} (arrow keys work too)`}
      className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full border border-border text-muted hover:text-accent hover:border-accent/40 transition-colors"
    >
      {children}
    </button>
  );
}
