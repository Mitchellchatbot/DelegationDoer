import Link from "next/link";
import { PriorityBadge, StalledBadge, Tag } from "./Badges";
import { Avatar } from "./Avatar";
import { Countdown } from "./Countdown";
import type { Task } from "@/lib/types";
import { userById } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";

export function TaskCard({ task, dim }: { task: Task; dim?: boolean }) {
  const assignee = userById(task.assigneeId);

  // Subtle priority-aware accent stripe on the left edge so cards differentiate
  // at a glance without being noisy. Stalled tasks override with the stalled tone.
  const stripeColor = task.inactiveFlag
    ? "bg-stalled"
    : task.priority === "critical" ? "bg-urgent"
    : task.priority === "high" ? "bg-warn"
    : task.priority === "medium" ? "bg-accent"
    : "bg-muted/40";

  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cn(
        "card card-hover p-3 block relative overflow-hidden transition-transform hover:-translate-y-0.5",
        task.inactiveFlag && "border-stalled/50",
        dim && "dim"
      )}
    >
      <span aria-hidden className={cn("absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl", stripeColor)} />
      <div className="flex items-start justify-between gap-2 pl-1.5">
        <div className="text-sm font-medium leading-snug">{task.title}</div>
        <PriorityBadge priority={task.priority} />
      </div>
      <div className="mt-2 pl-1.5 flex items-center gap-1.5 flex-wrap">
        {task.tags.slice(0, 3).map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
        {task.inactiveFlag && <StalledBadge />}
      </div>
      <div className="mt-3 pl-1.5 flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-2">
          {assignee ? <Avatar name={assignee.name} imageUrl={assignee.avatarUrl} size={20} /> : <span className="text-muted">Unassigned</span>}
          {assignee && <span>{assignee.name}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          <Countdown iso={task.dueDate} />
        </div>
      </div>
    </Link>
  );
}
