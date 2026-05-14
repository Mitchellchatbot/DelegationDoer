import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllUsersLight } from "@/lib/server-data";
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

  // Resolve assignee names from the live users table so the client
  // component doesn't need access to the workspace roster.
  const users = await getAllUsersLight();
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const enriched = list.map((i) => ({
    ...i,
    assigneeName: i.assignedToId ? (nameById.get(i.assignedToId) ?? null) : null
  }));

  return <IncidentsList incidents={enriched} />;
}
