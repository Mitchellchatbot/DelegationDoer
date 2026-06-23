import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// CRUD layer for the public.outbound_typeform_forms catalog — the
// mapping of Typeform form IDs to human-readable labels rendered as
// per-form blocks on /outbound-dashboard/leads.
//
// The Typeform webhook never blocks on this catalog. If a form fires
// with an ID we haven't registered yet, the lead still gets created
// and surfaces under an "Unknown forms" block on the leads page until
// the operator opens the Manage Forms drawer and gives it a name.

export interface OutboundTypeformForm {
  id: string;
  label: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FormRow {
  id: string;
  label: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function normalize(r: FormRow): OutboundTypeformForm {
  return {
    id: r.id,
    label: r.label,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export async function listForms(): Promise<OutboundTypeformForm[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_typeform_forms")
    .select("*")
    .order("label", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as FormRow[]).map(normalize);
}

export async function getForm(id: string): Promise<OutboundTypeformForm | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_typeform_forms")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalize(data as FormRow) : null;
}

export async function upsertForm(input: {
  id: string;
  label: string;
  description?: string | null;
}): Promise<OutboundTypeformForm> {
  const id = input.id.trim();
  const label = input.label.trim();
  if (!id) throw new Error("id is required");
  if (!label) throw new Error("label is required");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outbound_typeform_forms")
    .upsert({
      id,
      label,
      description: input.description?.trim() || null
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return normalize(data as FormRow);
}

export async function deleteForm(id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("outbound_typeform_forms")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// Bulk label resolver — used by the leads page to render each form
// section header. Returns a Map keyed by form_id for O(1) lookup.
export async function getFormLabelMap(): Promise<Map<string, string>> {
  const forms = await listForms();
  const m = new Map<string, string>();
  for (const f of forms) m.set(f.id, f.label);
  return m;
}
