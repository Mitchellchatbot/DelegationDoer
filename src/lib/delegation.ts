import { departments, users, skillProfiles } from "./mock-data";
import { userCapacity } from "./capacity";
import type { Ticket, User } from "./types";

export interface DelegationSuggestion {
  user: User;
  reason: string;
  capacityPct: number;
}

// Naive scoring: department match → skill match → capacity slack.
// Never recommend someone above 85% utilization.
export function suggestAssignees(
  ticket: Pick<Ticket, "title" | "description" | "departmentId" | "tags">,
  openTickets: Ticket[],
  taskType?: string
): DelegationSuggestion[] {
  const dept = departments.find((d) => d.id === ticket.departmentId);
  const candidates = users.filter((u) => !ticket.departmentId || u.departmentIds.includes(ticket.departmentId));

  const text = `${ticket.title} ${ticket.description ?? ""}`.toLowerCase();
  const inferredType = taskType ?? dept?.taskTypes.find((t) => text.includes(t.toLowerCase()));

  const scored = candidates.map((u) => {
    const cap = userCapacity(u, openTickets);
    const skills = skillProfiles.filter((s) => s.userId === u.id);
    const skillHit = skills.some((s) =>
      inferredType ? s.taskTypes.includes(inferredType) : false
    );
    const skillKeyword = u.skills.some((sk) => text.includes(sk.toLowerCase()));

    let score = 0;
    if (dept && u.departmentIds.includes(dept.id)) score += 3;
    if (skillHit) score += 4;
    if (skillKeyword) score += 2;
    score += Math.max(0, 1 - cap.pct) * 3; // prefer free capacity

    let reason = "";
    if (skillHit && inferredType) reason = `Owns "${inferredType}" task type and is at ${Math.round(cap.pct * 100)}% capacity`;
    else if (skillKeyword) reason = `Skills overlap with the ticket; ${Math.round(cap.pct * 100)}% capacity`;
    else if (dept && u.departmentIds.includes(dept.id)) reason = `In ${dept.name}; ${Math.round(cap.pct * 100)}% capacity`;
    else reason = `Available cross-department; ${Math.round(cap.pct * 100)}% capacity`;

    return { user: u, score, reason, capacityPct: cap.pct, overBuffer: cap.overBuffer };
  });

  return scored
    .filter((s) => !s.overBuffer)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ user, reason, capacityPct }) => ({ user, reason, capacityPct }));
}
