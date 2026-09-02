import Link from "next/link";
import { redirect } from "next/navigation";
import { Users2, Briefcase } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsers } from "@/lib/server-data";
import { getClients } from "@/lib/clients-data";
import { canManageAssignments } from "@/lib/inbox-access";
import { TEAMS, teamsForDepartment, type TeamId } from "@/lib/client-teams";
import {
  ClientTeamsBoard,
  type BoardClient,
  type BoardColumn,
  type BoardUser
} from "@/components/ClientTeamsBoard";

export const dynamic = "force-dynamic";

// /client-teams — "who owns which SEO client".
//
// This is a *view* over clients.team_id, not a second copy of the
// assignment. The same field is edited by the picker on /clients; this page
// just presents it lead-by-lead so leadership can see the split at a glance
// and rebalance by dragging.
//
// Visible to everyone (knowing who owns a client is not sensitive, and the
// leads need to read it). Editing is gated on canManageAssignments —
// leader OR stealth admin — which is the same gate the underlying
// PATCH /api/clients/[id] enforces server-side. The client-side `canEdit`
// only hides affordances; it is not the security boundary.
export default async function ClientTeamsPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const [clients, allUsers] = await Promise.all([getClients(), getAllUsers()]);

  const seoTeamIds = new Set<string>(teamsForDepartment("dep_seo"));

  // Only SEO buckets get a column, plus a trailing Unassigned column. A
  // Websites/Software client has no column here and is filtered out
  // entirely — this page is scoped to the SEO split.
  const columns: BoardColumn[] = [
    ...TEAMS.filter((t) => seoTeamIds.has(t.id)).map((t) => ({
      teamId: t.id as TeamId,
      label: t.label.replace(/^SEO · /, ""),
      leadEmail: t.leadEmail
    })),
    { teamId: null, label: "Unassigned" }
  ];

  // Narrow projection — see BoardClient. Unassigned clients are included
  // (they're the ones that need triaging); non-SEO-owned ones are not.
  const boardClients: BoardClient[] = clients
    .filter((c) => c.teamId === null || seoTeamIds.has(c.teamId))
    .map((c) => ({
      id: c.id,
      name: c.name,
      website: c.website,
      iconUrl: c.iconUrl,
      teamId: c.teamId,
      assignedUserIds: c.assignedUserIds ?? []
    }));

  const users: BoardUser[] = allUsers.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email ?? null,
    avatarUrl: u.avatarUrl ?? null
  }));

  const canEdit = canManageAssignments(me);
  const assigned = boardClients.filter((c) => c.teamId !== null).length;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="SEO"
        headline={["Client ", { accent: "split" }]}
        subtitle={
          canEdit
            ? "How SEO clients are divided between team leads. Drag a client to move them."
            : "How SEO clients are divided between team leads."
        }
        icon={<Users2 />}
        iconTone="emerald"
        meta={[
          { count: assigned, label: "assigned" },
          { count: boardClients.length - assigned, label: "unassigned" }
        ]}
        trailing={
          <Link
            href="/clients"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
          >
            <Briefcase className="w-3.5 h-3.5" />
            All clients
          </Link>
        }
      />
      <ClientTeamsBoard
        clients={boardClients}
        users={users}
        columns={columns}
        canEdit={canEdit}
      />
    </div>
  );
}
