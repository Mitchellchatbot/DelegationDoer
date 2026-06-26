import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpDown, Briefcase, LayoutGrid, FileSpreadsheet, Activity, Mail } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments } from "@/lib/inbox-access";
import { isApprover } from "@/lib/email-approvers";
import { getClients, getOpenTaskCountsByClient } from "@/lib/clients-data";
import { getAllUsers } from "@/lib/server-data";
import { NewClientDialog } from "@/components/NewClientDialog";
import { ClientPriorityList } from "@/components/ClientPriorityList";
import { RescanClientMailButton } from "@/components/RescanClientMailButton";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const [clients, openCountsMap, allUsers] = await Promise.all([
    getClients(),                  // already sorted by display_order asc
    getOpenTaskCountsByClient(),
    // getAllUsers (not Light) so each user carries departmentIds — the
    // team-picker filters point people by the selected team's department,
    // which is impossible with the Light variant's empty membership.
    getAllUsers()
  ]);

  // Plain object so we can pass it to a client component without serializing
  // a Map.
  const openCounts: Record<string, number> = {};
  openCountsMap.forEach((v, k) => { openCounts[k] = v; });

  // Trim users to the fields the picker actually shows — keeps the
  // bundle / serialization small.
  const pickableUsers = allUsers
    .filter((u) => u.role !== "leader")
    .map((u) => ({
      id: u.id,
      name: u.name,
      avatarUrl: u.avatarUrl ?? null,
      role: u.role,
      departmentIds: u.departmentIds ?? []
    }));

  const canEdit = canManageAssignments(me);
  const canBulkEmail = isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin });

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Clients"
        headline={["At-risk ", { accent: "first" }]}
        subtitle={
          canEdit
            ? "At-risk clients surface at the top for everyone. Switch to the Priority sort to drag-reorder by hand."
            : "At-risk clients surface at the top. Switch to the Priority sort to see the Leader's order."
        }
        icon={<Briefcase />}
        iconTone="amber"
        trailing={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Cross-client Kanban — same data, different cut.
                /tasks/board?groupBy=client renders one column per
                client with their open work as cards. Mirrors the old
                Notion "Website Client History" board so the team has
                a familiar scan view inside DD. */}
            <Link
              href="/client-health"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
            >
              <Activity className="w-3.5 h-3.5" />
              Health dashboard
            </Link>
            <Link
              href="/tasks/board?groupBy=client"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Cross-client board
            </Link>
            {canBulkEmail && (
              <Link
                href="/clients/bulk-email"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
              >
                <Mail className="w-3.5 h-3.5" />
                Bulk SEO update
              </Link>
            )}
            {canEdit && (
              <Link
                href="/clients/import"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Import from Notion
              </Link>
            )}
            {canEdit && <RescanClientMailButton />}
            <NewClientDialog />
          </div>
        }
      />

      {canEdit && clients.length > 1 && (
        <div className="flex items-center gap-1.5 text-[11px] text-ink/60 px-2">
          <ArrowUpDown className="w-3 h-3" />
          Switch to the Priority sort, then drag the grip handle to reorder.
        </div>
      )}

      <ClientPriorityList
        initial={clients}
        openCounts={openCounts}
        canEdit={canEdit}
        pickableUsers={pickableUsers}
      />
    </div>
  );
}
