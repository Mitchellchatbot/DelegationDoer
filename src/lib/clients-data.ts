// Server-only helpers for the Client Hub.
//
// Three concepts:
//   - Client       — top-level folder per customer (Acme Insurance, ...)
//   - Resource     — one of {meeting, document, suggestion} attached to a
//                    client. Polymorphic via the `kind` discriminator.
//
// Tasks remain linked to clients by free-text `client_name` (no FK) so we
// don't have to migrate historical data; getClient() looks up tasks by
// the client's name.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type ResourceKind = "meeting" | "document" | "suggestion";
export type ClientPriority = "low" | "medium" | "high";

export interface Client {
  id: string;
  name: string;
  website: string | null;
  priority: ClientPriority;
  notes: string | null;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClientResource {
  id: string;
  clientId: string;
  kind: ResourceKind;
  title: string;
  url: string | null;
  body: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface ClientRow {
  id: string;
  name: string;
  website: string | null;
  priority: ClientPriority;
  notes: string | null;
  display_order: number | string; // pg numeric → string
  created_at: string;
  updated_at: string;
}

interface ResourceRow {
  id: string;
  client_id: string;
  kind: ResourceKind;
  title: string;
  url: string | null;
  body: string | null;
  created_by: string | null;
  created_at: string;
}

function rowToClient(r: ClientRow): Client {
  return {
    id: r.id,
    name: r.name,
    website: r.website,
    priority: r.priority,
    notes: r.notes,
    displayOrder: Number(r.display_order ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
function rowToResource(r: ResourceRow): ClientResource {
  return {
    id: r.id,
    clientId: r.client_id,
    kind: r.kind,
    title: r.title,
    url: r.url,
    body: r.body,
    createdBy: r.created_by,
    createdAt: r.created_at
  };
}

export async function getClients(): Promise<Client[]> {
  const { data } = await getSupabaseAdmin()
    .from("clients")
    .select("*")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });
  return (data ?? []).map((r) => rowToClient(r as ClientRow));
}

export async function getClient(id: string): Promise<Client | null> {
  const { data } = await getSupabaseAdmin()
    .from("clients")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return data ? rowToClient(data as ClientRow) : null;
}

export async function getResourcesForClient(clientId: string): Promise<ClientResource[]> {
  const { data } = await getSupabaseAdmin()
    .from("client_resources")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => rowToResource(r as ResourceRow));
}

// Per-client task count, used on the list page so cards show "N open" without
// a per-card N+1 query.
export async function getOpenTaskCountsByClient(): Promise<Map<string, number>> {
  const { data } = await getSupabaseAdmin()
    .from("tasks")
    .select("client_name")
    .neq("status", "done")
    .not("client_name", "is", null);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { client_name: string | null }[]) {
    if (!row.client_name) continue;
    counts.set(row.client_name, (counts.get(row.client_name) ?? 0) + 1);
  }
  return counts;
}
