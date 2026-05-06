import Link from "next/link";
import { PriorityBadge, StalledBadge, Tag } from "./Badges";
import { Avatar } from "./Avatar";
import { Countdown } from "./Countdown";
import type { Ticket } from "@/lib/types";
import { userById } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";

export function TicketCard({ ticket, dim }: { ticket: Ticket; dim?: boolean }) {
  const assignee = userById(ticket.assigneeId);
  return (
    <Link
      href={`/tickets/${ticket.id}`}
      className={cn(
        "card card-hover p-3 block",
        ticket.inactiveFlag && "border-stalled/50",
        dim && "dim"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-snug">{ticket.title}</div>
        <PriorityBadge priority={ticket.priority} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {ticket.tags.slice(0, 3).map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
        {ticket.inactiveFlag && <StalledBadge />}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-2">
          {assignee ? <Avatar name={assignee.name} imageUrl={assignee.avatarUrl} size={20} /> : <span className="text-muted">Unassigned</span>}
          {assignee && <span>{assignee.name}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          <Countdown iso={ticket.dueDate} />
        </div>
      </div>
    </Link>
  );
}
