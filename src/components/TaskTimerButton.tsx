"use client";

import { Play, Square } from "lucide-react";
import { useClock } from "./ClockContext";

// Tap to start a timer on a task. When already running, the same button
// stops it. Writes directly to /api/tasks/[id]/timer, which segments the
// time_entries table — the widget polls the same endpoint and stays in
// sync within ~10s.
export function TaskTimerButton({ taskId }: { taskId: string }) {
  const { clock, startTask, stopTask, tick } = useClock();
  void tick;
  const isActive = clock.open?.taskId === taskId;
  const hoursToday = clock.hoursByTask?.[taskId] ?? 0;

  return (
    <button
      type="button"
      onClick={() => (isActive ? stopTask(taskId) : startTask(taskId))}
      className={
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all active:scale-95 " +
        (isActive
          ? "bg-emerald-500 border-emerald-600 text-white shadow-sm"
          : "bg-white border-slate-200 text-ink hover:border-accent/40 hover:text-accent")
      }
      title={isActive ? "Stop timer for this task" : "Start timer for this task"}
    >
      {isActive ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      {isActive ? "Stop timer" : "Start timer"}
      {hoursToday > 0 && (
        <span className="ml-1 text-[11px] opacity-80 tabular-nums">
          {hoursToday.toFixed(1)}h today
        </span>
      )}
    </button>
  );
}
