"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
}

const COLLAPSED_LIMIT = 3;

export function ClientOpenTasksList({ tasks }: { tasks: Task[] }) {
  const [open, setOpen] = useState(false);
  const showAll = open || tasks.length <= COLLAPSED_LIMIT;
  const visible = showAll ? tasks : tasks.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = tasks.length - COLLAPSED_LIMIT;

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-blue-50/60 to-white p-4 space-y-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          <div className="text-sm font-semibold inline-flex items-center gap-1.5">
            <ListChecks className="w-4 h-4" /> Open tasks
          </div>
          <span className="text-xs text-muted">· {tasks.length}</span>
        </div>
      </header>

      {tasks.length === 0 ? (
        <div className="text-xs text-muted italic px-1">
          No open tasks linked to this client.
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {visible.map((t) => (
              <Link
                key={t.id}
                href={`/tasks/${t.id}`}
                className="group flex items-center gap-2 p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-blue-200 hover:bg-blue-50/40 transition-colors"
              >
                <div className="text-sm flex-1 truncate group-hover:text-accent">{t.title}</div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/60 capitalize">
                  {t.status.replace("_", " ")}
                </span>
              </Link>
            ))}
          </div>
          {tasks.length > COLLAPSED_LIMIT && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="w-full inline-flex items-center justify-center gap-1 text-[11px] font-medium text-blue-700/80 hover:text-blue-800 py-1"
            >
              {open ? "Show less" : `See all ${tasks.length}`}
              <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
            </button>
          )}
        </>
      )}
    </section>
  );
}
