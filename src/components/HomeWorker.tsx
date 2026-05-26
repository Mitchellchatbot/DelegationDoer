"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Clock, Loader2, ListChecks, ArrowRight, Sun, CheckCircle2
} from "lucide-react";
import { toast } from "sonner";
import { useClock } from "@/components/ClockContext";
import { Countdown } from "@/components/Countdown";
import { PriorityBadge } from "@/components/Badges";
import { cn } from "@/lib/utils";
import type { HomeTask } from "@/lib/home-data";

// /home rendering for workers. Two strips, top to bottom:
//   1. Clock strip — clocked-out CTA OR clocked-in live timer
//   2. Today's tasks — capped at 8, sort = due then priority
//
// SOD/EOD prompts moved into <DayBookends />, rendered by the parent
// page so they sit above this view. Intentionally spare otherwise.

interface Props {
  meName: string;
  tasks: HomeTask[];
}

export function HomeWorker({ meName, tasks }: Props) {
  const firstName = meName.split(" ")[0];
  return (
    <div className="space-y-3">
      <Header firstName={firstName} />
      <ClockStrip />
      <TasksStrip tasks={tasks} />
    </div>
  );
}

function Header({ firstName }: { firstName: string }) {
  return (
    <header className="rounded-2xl border border-sky-200/60 shadow-soft p-4 bg-gradient-to-r from-sky-50 via-white to-sky-50/60">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/80 grid place-items-center text-sky-600 shrink-0 shadow-sm">
          <Sun className="w-5 h-5" />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-sky-700">
            Today
          </div>
          <h1 className="text-[20px] font-bold text-ink leading-tight">
            Hey {firstName} — here's your day
          </h1>
        </div>
      </div>
    </header>
  );
}

function ClockStrip() {
  const { clock, toggleShift, tick } = useClock();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      await toggleShift();
      toast.success(clock.open ? "Clocked out — see you tomorrow" : "Clocked in — have a good day");
    } catch {
      toast.error("Couldn't toggle the clock");
    } finally {
      setBusy(false);
    }
  }

  if (!clock.open) {
    return (
      <div className="rounded-2xl border border-amber-200/60 bg-amber-50/60 p-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-white grid place-items-center text-amber-600 shrink-0">
          <Clock className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-amber-900">You're not clocked in yet.</div>
          <div className="text-[11px] text-amber-800/80">Clock in to track today's hours and unlock your tasks.</div>
        </div>
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
            busy && "opacity-60 cursor-not-allowed"
          )}
          style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
          {busy ? "Clocking in…" : "Clock in"}
        </button>
      </div>
    );
  }

  // Clocked-in state — live timer ticking via the provider's `tick`.
  // We use `tick` only to keep the ref fresh; the actual ms diff is
  // computed off Date.now() each render.
  void tick;
  const elapsedMs = Date.now() - new Date(clock.open.startedAt).getTime();
  const hours = Math.floor(elapsedMs / 3_600_000);
  const minutes = Math.floor((elapsedMs % 3_600_000) / 60_000);
  return (
    <div className="rounded-2xl border border-emerald-200/60 bg-emerald-50/60 p-3 flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-white grid place-items-center text-emerald-600 shrink-0">
        <Clock className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-emerald-900">
          Clocked in{" "}
          <span className="tabular-nums">{hours}h {minutes.toString().padStart(2, "0")}m</span>
        </div>
        <div className="text-[11px] text-emerald-800/80">
          {clock.workdayRemainingMs > 0
            ? `~${Math.round(clock.workdayRemainingMs / 3_600_000 * 10) / 10}h left in your workday`
            : "You've passed today's capacity — wrap up when you can."}
        </div>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50 transition-colors",
          busy && "opacity-60 cursor-not-allowed"
        )}
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
        Clock out
      </button>
    </div>
  );
}

function TasksStrip({ tasks }: { tasks: HomeTask[] }) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-indigo-500" />
          Today's tasks
          <span className="text-[11px] text-ink/55 font-normal tabular-nums">· {tasks.length}</span>
        </div>
        <Link
          href="/tasks/mine"
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          See all <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      {tasks.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          Nothing on today's plate. Either you're caught up, or you've got room for new work.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tasks/${t.id}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink truncate flex items-center gap-2">
                    {t.title}
                    {t.isInProgress && (
                      <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200/60 font-semibold">
                        in progress
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-ink/55 mt-0.5">
                    <PriorityBadge priority={t.priority} />
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {t.dueDate ? <Countdown iso={t.dueDate} /> : <span className="text-muted">no deadline</span>}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
