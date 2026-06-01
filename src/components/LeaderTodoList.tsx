"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ListChecks, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface LeaderTodo {
  id: string;
  title: string;
  priority: "low" | "medium" | "high" | "critical";
  dueDate: string | null;
  clientName: string | null;
}

// Apple-Reminders-style todo card for the leader's own open tasks.
//
// Visual references the user asked for:
//   • Round empty circle on the left of each row.
//   • Tap completes — the circle fills with accent, a checkmark
//     appears, and the title strikes through. The row then fades +
//     slides out after a short delay so the leader can see what they
//     just completed before it leaves.
//   • Subtitle shows client + due date in muted small text.
//
// "Done" hits PATCH /api/tasks/[id] with { status: "done" }; we
// update local state immediately (optimistic) and revert if the API
// errors. No drag-reorder — the server-side priority sort is the
// canonical order, manual reorder would diverge from /tasks views.

interface RowState {
  completed: boolean;     // user just toggled it
  hiding: boolean;        // animating out
}

export function LeaderTodoList({ tasks }: { tasks: LeaderTodo[] }) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, RowState>>({});

  const visible = useMemo(
    () => tasks.filter((t) => !(state[t.id]?.hiding ?? false)),
    [tasks, state]
  );

  async function complete(t: LeaderTodo) {
    // Optimistic UI: mark as completed (circle fills, strikethrough)
    setState((s) => ({ ...s, [t.id]: { completed: true, hiding: false } }));
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Done — ${t.title}`);
      // Slide out after a short delay so the check animation is visible.
      window.setTimeout(() => {
        setState((s) => ({ ...s, [t.id]: { completed: true, hiding: true } }));
        router.refresh();
      }, 600);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't complete");
      setState((s) => ({ ...s, [t.id]: { completed: false, hiding: false } }));
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-indigo-500" />
          Your reminders
          <span className="text-[11px] text-ink/55 font-normal tabular-nums">
            · {visible.length}
          </span>
        </div>
        <Link
          href="/my-tasks"
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          All my tasks <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      {visible.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-ink/55">
          🎉 Nothing on your plate right now.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-[480px] overflow-y-auto">
          {visible.map((t) => {
            const completed = state[t.id]?.completed ?? false;
            const hiding = state[t.id]?.hiding ?? false;
            return (
              <li
                key={t.id}
                className={cn(
                  "transition-all duration-300",
                  hiding && "opacity-0 -translate-x-2 max-h-0 overflow-hidden"
                )}
                style={{ transformOrigin: "left center" }}
              >
                <div className="flex items-start gap-3 px-4 py-2.5 group">
                  {/* Apple-style round checkbox. Filled + check on
                      completion. Click area is the whole circle so it
                      doesn't compete with the row's task-detail link. */}
                  <button
                    type="button"
                    onClick={() => { if (!completed) void complete(t); }}
                    disabled={completed}
                    aria-label="Mark complete"
                    className={cn(
                      "shrink-0 mt-0.5 w-5 h-5 rounded-full border-[1.5px] grid place-items-center transition-all duration-200",
                      completed
                        ? "bg-accent border-accent shadow-[0_0_0_3px_rgba(37,99,235,0.12)] scale-110"
                        : "border-slate-300 hover:border-accent/70 group-hover:border-accent/70"
                    )}
                  >
                    {completed && (
                      <Check
                        className="w-3 h-3 text-white animate-in zoom-in-50 duration-200"
                        strokeWidth={3.5}
                      />
                    )}
                  </button>

                  <Link
                    href={`/tasks/${t.id}`}
                    className="min-w-0 flex-1 group/title rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40"
                  >
                    <div
                      className={cn(
                        "text-[13.5px] truncate transition-all",
                        completed
                          ? "text-ink/40 line-through"
                          : "text-ink font-medium group-hover/title:text-accent"
                      )}
                    >
                      {t.title}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] text-ink/55 truncate">
                      {/* Priority pip — small colored dot, Apple-Reminders
                          uses an exclamation mark; we lean dot + label
                          so it's recognizable at a glance. */}
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wide",
                          PRIORITY_CHIP[t.priority]
                        )}
                      >
                        {t.priority}
                      </span>
                      {t.clientName && (
                        <span className="truncate">· {t.clientName}</span>
                      )}
                      {t.dueDate && (
                        <span
                          className={cn(
                            "ml-auto pl-2 shrink-0 tabular-nums",
                            isOverdue(t.dueDate) && !completed && "text-rose-600 font-medium"
                          )}
                        >
                          {formatDue(t.dueDate)}
                        </span>
                      )}
                    </div>
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const PRIORITY_CHIP: Record<LeaderTodo["priority"], string> = {
  critical: "bg-rose-50 text-rose-700 border-rose-200/70",
  high:     "bg-amber-50 text-amber-700 border-amber-200/70",
  medium:   "bg-indigo-50 text-indigo-700 border-indigo-200/70",
  low:      "bg-slate-50 text-slate-600 border-slate-200/70"
};

function isOverdue(iso: string): boolean {
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t < Date.now();
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDue = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startOfDue.getTime() - startOfToday.getTime()) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Tomorrow";
  if (dayDiff === -1) return "Yesterday";
  if (dayDiff < -1 && dayDiff > -7) return `${Math.abs(dayDiff)}d overdue`;
  if (dayDiff > 1 && dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
