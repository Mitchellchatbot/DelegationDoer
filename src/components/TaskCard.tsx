"use client";

import Link from "next/link";
import { PriorityBadge, StalledBadge, Tag } from "./Badges";
import { PersonAvatar } from "./PersonAvatar";
import { Countdown } from "./Countdown";
import type { Task } from "@/lib/types";
import { useTeam } from "@/lib/team-context";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";

// Visual language matches ThreadCard / ClientCard but with a priority-tinted
// gradient on the card itself — a flat white wash blurred against a white
// panel doesn't read as glass, so each priority gets its own subtle color
// gradient that the stripe edge dissolves into.

type Priority = "critical" | "high" | "medium" | "low";

const TINT: Record<Priority, { bg: string; border: string; stripe: string }> = {
  critical: {
    bg: "bg-gradient-to-br from-rose-100/80 via-white/55 to-white/40",
    border: "border-rose-200/70",
    stripe: "bg-gradient-to-b from-rose-500 to-red-500"
  },
  high: {
    bg: "bg-gradient-to-br from-amber-100/80 via-white/55 to-white/40",
    border: "border-amber-200/70",
    stripe: "bg-gradient-to-b from-amber-500 to-orange-500"
  },
  medium: {
    bg: "bg-gradient-to-br from-blue-100/80 via-indigo-50/55 to-white/40",
    border: "border-blue-200/70",
    stripe: "bg-gradient-to-b from-blue-500 to-indigo-500"
  },
  low: {
    bg: "bg-gradient-to-br from-slate-100/70 via-white/55 to-white/40",
    border: "border-slate-200/60",
    stripe: "bg-gradient-to-b from-slate-300 to-slate-400"
  }
};

const STALLED_TINT = {
  bg: "bg-gradient-to-br from-yellow-100/80 via-white/55 to-white/40",
  border: "border-yellow-300/60",
  stripe: "bg-gradient-to-b from-yellow-500 to-amber-500"
};

export function TaskCard({ task, dim }: { task: Task; dim?: boolean }) {
  const { userById } = useTeam();
  const assignee = userById(task.assigneeId);
  const tint = task.inactiveFlag ? STALLED_TINT : TINT[task.priority as Priority];

  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cn(
        "group relative overflow-hidden rounded-2xl border backdrop-blur-md p-3.5 block shadow-soft hover:shadow-lift hover:-translate-y-0.5 transition-all",
        tint.bg,
        tint.border,
        dim && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-snug group-hover:text-accent transition-colors">
          {task.title}
        </div>
        <PriorityBadge priority={task.priority} />
      </div>

      {(task.tags.length > 0 || task.inactiveFlag) && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {task.tags.slice(0, 3).map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
          {task.inactiveFlag && <StalledBadge />}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-2 min-w-0">
          {assignee ? (
            <>
              <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={20} />
              <span className="truncate">{assignee.name}</span>
            </>
          ) : (
            <span className="text-muted">Unassigned</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Clock className="w-3 h-3" />
          <Countdown iso={task.dueDate} />
        </div>
      </div>
    </Link>
  );
}
