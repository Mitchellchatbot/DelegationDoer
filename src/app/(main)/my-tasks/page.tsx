import { currentUser } from "@/lib/mock-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { TicketCard } from "@/components/TicketCard";
import type { Ticket } from "@/lib/types";

// Source of truth for tickets is now Supabase. Server component so we read
// fresh on every navigation; opt out of route-handler-style caching.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function focusSort(a: Ticket, b: Ticket) {
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  const aBlocks = a.blocksTicketIds.length, bBlocks = b.blocksTicketIds.length;
  if (aBlocks !== bBlocks) return bBlocks - aBlocks;
  const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
  const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
  return aDue - bDue;
}

function isImminent(t: Ticket) {
  if (!t.dueDate) return false;
  return new Date(t.dueDate).getTime() < Date.now() + 3 * 86400000;
}

function rowToTicket(t: any): Ticket {
  return {
    id: t.id,
    title: t.title,
    description: t.description ?? "",
    status: t.status,
    priority: t.priority,
    estimatedHours: Number(t.estimated_hours),
    actualHours: Number(t.actual_hours ?? 0),
    tags: t.tags ?? [],
    departmentId: t.department_id,
    assigneeId: t.assignee_id,
    creatorId: t.creator_id,
    projectId: t.project_id,
    dueDate: t.due_date,
    inactiveFlag: !!t.inactive_flag,
    lastActivityAt: t.last_activity_at,
    createdAt: t.created_at,
    blocksTicketIds: t.blocks_ticket_ids ?? []
  };
}

export default async function MyTasksPage() {
  const supabase = getSupabaseAdmin();
  const { data: rows } = await supabase
    .from("tickets")
    .select("*")
    .eq("assignee_id", currentUser.id)
    .neq("status", "done");

  const mine = (rows ?? []).map(rowToTicket).sort(focusSort);

  const urgentCount = mine.filter((t) => t.priority === "critical" || t.status === "urgent").length;
  const dueWeek = mine.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < Date.now() + 7 * 86400000).length;

  // "Blocked / waiting" should reflect the user's own queue, not the whole
  // org. Counts tickets in waiting_on_client status assigned to me.
  const blocked = mine.filter((t) => t.status === "waiting_on_client").length;

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="text-sm text-muted">What actually matters today</div>
        <div className="mt-2 flex items-center gap-6">
          <div><span className="text-2xl font-medium text-urgent">{urgentCount}</span> <span className="text-muted text-sm">urgent</span></div>
          <div><span className="text-2xl font-medium">{dueWeek}</span> <span className="text-muted text-sm">due this week</span></div>
          <div><span className="text-2xl font-medium text-warn">{blocked}</span> <span className="text-muted text-sm">blocked / waiting</span></div>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium mb-3">Focus queue · sorted by priority → blockers → deadline</h2>
        {mine.length === 0 ? (
          <div className="card p-6 text-sm text-muted text-center">Nothing assigned to you right now.</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {mine.map((t) => (
              <TicketCard key={t.id} ticket={t} dim={t.priority === "low" && !isImminent(t)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
