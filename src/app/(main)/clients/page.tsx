import { redirect } from "next/navigation";
import { ArrowUpDown, Briefcase } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments } from "@/lib/inbox-access";
import { getClients, getOpenTaskCountsByClient } from "@/lib/clients-data";
import { NewClientDialog } from "@/components/NewClientDialog";
import { ClientPriorityList } from "@/components/ClientPriorityList";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const [clients, openCountsMap] = await Promise.all([
    getClients(),                  // already sorted by display_order asc
    getOpenTaskCountsByClient()
  ]);

  // Plain object so we can pass it to a client component without serializing
  // a Map.
  const openCounts: Record<string, number> = {};
  openCountsMap.forEach((v, k) => { openCounts[k] = v; });

  const canEdit = canManageAssignments(me);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Clients"
        headline={["Sorted by ", { accent: "priority" }]}
        subtitle={
          canEdit
            ? "Drag a client up or down to set its priority — top of the list is most urgent."
            : "Ordered by the CEO's priority — most urgent at the top."
        }
        icon={<Briefcase />}
        iconTone="amber"
        trailing={<NewClientDialog />}
      />

      {canEdit && clients.length > 1 && (
        <div className="flex items-center gap-1.5 text-[11px] text-ink/60 px-2">
          <ArrowUpDown className="w-3 h-3" />
          Most urgent at the top — drag the grip handle to reorder.
        </div>
      )}

      <ClientPriorityList
        initial={clients}
        openCounts={openCounts}
        canEdit={canEdit}
      />
    </div>
  );
}
