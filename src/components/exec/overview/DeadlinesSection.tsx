import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { PriorityBadge, StatusPill } from "@/components/Badges";
import { formatInZone, pluralize } from "@/lib/exec/format";
import type { DeadlineOwner, DeadlineRow, OverviewDeadlines, OverviewSection } from "@/lib/exec/overview";
import type { TaskStatus } from "@/lib/exec/sources/dd-types";
import { SectionCard } from "../SectionCard";
import { dueIn, taskPath } from "./labels";

// Open tasks due in the next 7 days, soonest first (analysis/tasks.ts
// upcomingDeadlines), each linking to its task.

function ownerLabel(owner: DeadlineOwner): string {
  switch (owner.kind) {
    case "person":
      return owner.name;
    case "team":
      return `${owner.name} team`;
    case "unassigned":
      return "Unassigned";
    default:
      return "Unknown assignee";
  }
}

// In-progress and pending are the normal states of upcoming work; only the
// statuses that change what the deadline means are shown.
const NOTABLE_STATUS: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["urgent", "waiting_on_client", "pending_approval"]);

function DeadlineItem({ row, tz, now }: { row: DeadlineRow; tz: string; now: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <Link href={taskPath(row.taskId)} prefetch={false} className="break-words text-[13px] font-medium leading-snug text-ink hover:text-accent">
          {row.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
          <span className="break-words">{ownerLabel(row.owner)}</span>
          {row.clientName && <span className="break-words">· {row.clientName}</span>}
          {NOTABLE_STATUS.has(row.status) && <StatusPill status={row.status} />}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        {row.dueDate ? (
          <time dateTime={row.dueDate} className="text-[12px] font-medium tabular-nums text-ink">
            {formatInZone(row.dueDate, tz, "datetime", now)}
          </time>
        ) : null}
        <span className="text-[11px] tabular-nums text-muted">{dueIn(row.dueDate, now)}</span>
        <PriorityBadge priority={row.priority} />
      </div>
    </li>
  );
}

export function DeadlinesSection({ deadlines, tz, now }: { deadlines: OverviewSection<OverviewDeadlines>; tz: string; now: string }) {
  if (!deadlines.ok) return <SectionCard title="Upcoming deadlines" icon={CalendarClock} error />;
  const { items, total, days, limit } = deadlines.data;
  return (
    <SectionCard
      title="Upcoming deadlines"
      icon={CalendarClock}
      basis="record"
      subtitle={`Open tasks due in the next ${days} days`}
      action={total > limit ? `${items.length} of ${total}` : pluralize(total, "task")}
      empty={total === 0 ? `Nothing is due in the next ${days} days.` : undefined}
      padded={false}
    >
      <ol className="divide-y divide-slate-100">
        {items.map((row) => (
          <DeadlineItem key={row.taskId} row={row} tz={tz} now={now} />
        ))}
      </ol>
    </SectionCard>
  );
}
