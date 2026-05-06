import type { Priority, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PriorityBadge({ priority }: { priority: Priority }) {
  const map = {
    low: "badge-low",
    medium: "badge-medium",
    high: "badge-high",
    critical: "badge-critical"
  } as const;
  return <span className={cn("badge", map[priority])}>{priority}</span>;
}

const STATUS_COPY: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  urgent: "Urgent",
  waiting_on_client: "Waiting on Client",
  done: "Done"
};

export function StatusPill({ status }: { status: TaskStatus }) {
  const tone = {
    pending: "text-muted border-border bg-surface2",
    in_progress: "text-accent border-accent/30 bg-accent/10",
    urgent: "text-urgent border-urgent/40 bg-urgent/10",
    waiting_on_client: "text-warn border-warn/30 bg-warn/10",
    done: "text-ok border-ok/30 bg-ok/10"
  }[status];
  return <span className={cn("badge", tone)}>{STATUS_COPY[status]}</span>;
}

export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="badge badge-tag">#{children}</span>;
}

export function StalledBadge() {
  return <span className="badge badge-stalled">stalled 48h+</span>;
}
