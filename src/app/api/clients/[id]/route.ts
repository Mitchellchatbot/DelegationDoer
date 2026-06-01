import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isValidTeamId } from "@/lib/client-teams";

export const dynamic = "force-dynamic";

// PATCH /api/clients/[id]
//   body: {
//     teamId?: string | null,         // null clears the team
//     assignedUserId?: string | null  // null clears the point person
//   }
//
// Either field may be omitted to leave the other untouched. Updates
// validate against the shared TEAMS catalog + the users table. Leader/
// admin/head can change (any team member would be too loose for an
// org-wide ownership field).
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
    const update: Record<string, unknown> = {};

    if ("teamId" in body) {
      const raw = body.teamId;
      if (raw === null || raw === "" || raw === undefined) {
        update.team_id = null;
      } else if (isValidTeamId(raw)) {
        update.team_id = raw;
      } else {
        return NextResponse.json({ error: "teamId must be a known team or null" }, { status: 400 });
      }
    }

    if ("assignedUserId" in body) {
      const raw = body.assignedUserId;
      if (raw === null || raw === "" || raw === undefined) {
        update.assigned_user_id = null;
      } else if (typeof raw === "string") {
        // Verify the user actually exists before writing — saves us
        // having to FK-trust untrusted client input.
        const { data: u } = await supabase
          .from("users")
          .select("id")
          .eq("id", raw)
          .maybeSingle();
        if (!u) {
          return NextResponse.json({ error: "assignedUserId not a known user" }, { status: 400 });
        }
        update.assigned_user_id = raw;
      } else {
        return NextResponse.json({ error: "assignedUserId must be a string or null" }, { status: 400 });
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const { error } = await supabase
      .from("clients")
      .update(update)
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      teamId: ("team_id" in update ? (update.team_id as string | null) : undefined),
      assignedUserId: ("assigned_user_id" in update ? (update.assigned_user_id as string | null) : undefined)
    });
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
