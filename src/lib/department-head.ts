import { getSupabaseAdmin, isMissingColumnError } from "@/lib/supabase-admin";

type SbClient = ReturnType<typeof getSupabaseAdmin>;

// Who owns a department — the person auto-created work is assigned to (email
// intake, tl;dv meeting intake, routing rules), which also decides who gets the
// assignment Slack DM.
//
// This used to be answered by scanning department_members for someone with
// role='department_head' and taking the first match. That is wrong in a way
// that only shows up once anyone belongs to two departments: **role in DD is
// GLOBAL, not per-department**. Whoever leads Website carries
// role='department_head' inside *every* department they join, so the scan
// happily nominates a head for a department nobody actually leads — and,
// because neither query was ordered, it could nominate a *different* one
// between runs.
//
// departments.head_user_id (20260901000100) records who really runs a team.
// NULL is a meaningful answer, not a missing one: it means nobody has been
// designated, so callers fall back to the skill ranker or drop the item into
// routing review for a human. Assigning work to an arbitrary member is worse
// than admitting we don't know.
//
// Lived in three byte-identical copies before this (lib/email-intake.ts,
// lib/tldv-intake.ts, api/email-intake/classify) — hence one shared module.
export async function departmentHead(
  departmentId: string,
  supabase: SbClient = getSupabaseAdmin()
): Promise<{ id: string; name: string } | null> {
  const deptRes = await supabase
    .from("departments")
    .select("head_user_id")
    .eq("id", departmentId)
    .maybeSingle();

  // head_user_id ships in 20260901000100, and migrations here are applied by
  // hand. If this build is running against a database that hasn't had it
  // applied, fall back to the old member scan so intake keeps working rather
  // than silently assigning nothing.
  //
  // Gated strictly on "column does not exist". On any other error we must NOT
  // fall back: the legacy scan is exactly the behaviour this module exists to
  // remove, so a transient failure would quietly hand Facebook work to an
  // arbitrary member of a team nobody leads.
  if (isMissingColumnError(deptRes.error)) {
    return legacyDepartmentHead(departmentId, supabase);
  }
  if (deptRes.error) return null;

  const headId =
    (deptRes.data as { head_user_id: string | null } | null)?.head_user_id ?? null;
  if (!headId) return null;

  const { data: head } = await supabase
    .from("users")
    .select("id, name")
    .eq("id", headId)
    .maybeSingle();
  return head ? { id: head.id as string, name: head.name as string } : null;
}

// Pre-migration behaviour, preserved verbatim except for the .order("name")
// that at least makes the arbitrary pick a stable one.
async function legacyDepartmentHead(
  departmentId: string,
  supabase: SbClient
): Promise<{ id: string; name: string } | null> {
  const { data: members } = await supabase
    .from("department_members")
    .select("user_id")
    .eq("department_id", departmentId);
  const memberIds = (members ?? []).map((r: { user_id: string }) => r.user_id);
  if (memberIds.length === 0) return null;
  const { data: users } = await supabase
    .from("users")
    .select("id, name, role")
    .in("id", memberIds)
    .order("name");
  const head =
    (users ?? []).find((u: { role: string }) => u.role === "department_head") ??
    (users ?? [])[0];
  return head ? { id: head.id as string, name: head.name as string } : null;
}
