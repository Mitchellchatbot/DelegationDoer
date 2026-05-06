import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { userById } from "@/lib/mock-data";
import { IncidentsList } from "@/components/IncidentsList";
import type { IncidentLog } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function IncidentsPage() {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("incident_logs")
    .select("*")
    .order("created_at", { ascending: false });

  const list: IncidentLog[] = (data ?? []).map((i) => ({
    id: i.id,
    issueType: i.issue_type,
    affectedUrl: i.affected_url ?? "",
    description: i.description,
    assignedToId: i.assigned_to_id,
    resolutionNotes: i.resolution_notes,
    resolvedAt: i.resolved_at,
    createdAt: i.created_at
  }));

  // Resolve assignee names server-side from mock-data so the client component
  // doesn't need access to the users array.
  const enriched = list.map((i) => ({
    ...i,
    assigneeName: userById(i.assignedToId)?.name ?? null
  }));

  return <IncidentsList incidents={enriched} />;
}
