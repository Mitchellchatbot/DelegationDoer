"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CheckCircle2, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CompletedTaskRow {
  id: string;
  title: string;
  description: string | null;
  last_activity_at: string;
  priority?: string | null;
  tags?: string[] | null;
}

type Range = "30" | "90" | "all";

// Knowledge-base view of a client's completed work. Renders the title +
// description for each completed task and lets the user filter to the
// last 30 / 90 days, or "all". The Ask-AI tool (list_client_completed_tasks)
// reads the same underlying data so the agent can summarize history in
// natural language.
export function ClientKnowledgeBase({ tasks }: { tasks: CompletedTaskRow[] }) {
  const [range, setRange] = useState<Range>("90");

  const filtered = useMemo(() => {
    if (range === "all") return tasks;
    const days = range === "30" ? 30 : 90;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return tasks.filter((t) => {
      const ts = Date.parse(t.last_activity_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });
  }, [tasks, range]);

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-indigo-50/60 to-white p-4 space-y-3">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full bg-indigo-500" />
          <div className="text-sm font-semibold inline-flex items-center gap-1.5">
            <BookOpen className="w-4 h-4" /> Knowledge base · completed work
          </div>
          <span className="text-xs text-muted">· {filtered.length}</span>
        </div>
        <div className="inline-flex items-center gap-1">
          {(["30", "90", "all"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                range === r
                  ? "bg-indigo-100 text-indigo-700 border-indigo-200"
                  : "bg-white text-ink/65 border-slate-200 hover:text-ink hover:border-indigo-200"
              )}
            >
              {r === "all" ? "All" : `Last ${r}`}
            </button>
          ))}
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="text-xs text-muted italic px-1">
          {tasks.length === 0
            ? "No completed tasks yet."
            : "No completed tasks in this window — try expanding the range."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((t) => (
            <Link
              key={t.id}
              href={`/tasks/${t.id}`}
              className="group block p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-indigo-200 hover:bg-indigo-50/40 transition-colors"
            >
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <div className="text-sm font-medium truncate group-hover:text-accent">{t.title}</div>
                    <div className="text-[10px] text-ink/55 shrink-0 tabular-nums">
                      {new Date(t.last_activity_at).toLocaleDateString(undefined, {
                        month: "short", day: "numeric", year: "numeric"
                      })}
                    </div>
                  </div>
                  {t.description && (
                    <div className="text-[12px] text-ink/70 mt-1 whitespace-pre-wrap line-clamp-4">
                      {t.description}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
