import { redirect } from "next/navigation";
import { ArrowUpDown } from "lucide-react";
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
      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #DDD6FE 100%)" }}
      >
        <div className="relative flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🗂</span>
            <div>
              <h1 className="text-xl font-semibold">Clients</h1>
              <p className="text-sm text-ink/60 mt-0.5">
                {canEdit
                  ? "Drag a client up or down to set its priority — top of the list is most urgent."
                  : "Ordered by the CEO's priority — most urgent at the top."}
              </p>
            </div>
          </div>
          <NewClientDialog />
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

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
