import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isValidTeamId } from "@/lib/client-teams";

export const dynamic = "force-dynamic";

// PATCH /api/clients/[id]
//   body: { teamId: string | null }   // null clears the assignment
//
// Updates a single client's team assignment. Validates against the
// shared TEAMS catalog. Leader/admin/head can change (any team member
// would be too loose for an org-wide ownership field).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.role === "department_head" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader/head/admin only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raw = body?.teamId;
    let teamId: string | null;
    if (raw === null || raw === "" || raw === undefined) {
      teamId = null;
    } else if (isValidTeamId(raw)) {
      teamId = raw;
    } else {
      return NextResponse.json({ error: "teamId must be a known team or null" }, { status: 400 });
    }

    const { error } = await supabase
      .from("clients")
      .update({ team_id: teamId })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, teamId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/clients/[id] — remove a client. Leader/admin only.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const { error } = await supabase.from("clients").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
