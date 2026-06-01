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
      // Legacy single-owner path — translate to the array column for
      // forward compatibility, and still write the legacy column so
      // older readers that haven't been redeployed still see ownership.
      const raw = body.assignedUserId;
      if (raw === null || raw === "" || raw === undefined) {
        update.assigned_user_id = null;
        update.assigned_user_ids = [];
      } else if (typeof raw === "string") {
        const { data: u } = await supabase
          .from("users").select("id").eq("id", raw).maybeSingle();
        if (!u) {
          return NextResponse.json({ error: "assignedUserId not a known user" }, { status: 400 });
        }
        update.assigned_user_id = raw;
        update.assigned_user_ids = [raw];
      } else {
        return NextResponse.json({ error: "assignedUserId must be a string or null" }, { status: 400 });
      }
    }

    if ("assignedUserIds" in body) {
      const raw = body.assignedUserIds;
      if (!Array.isArray(raw)) {
        return NextResponse.json({ error: "assignedUserIds must be an array of user ids" }, { status: 400 });
      }
      const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
      // Dedup while preserving order.
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
      }
      if (unique.length > 0) {
        const { data: existing } = await supabase
          .from("users").select("id").in("id", unique);
        const existingIds = new Set((existing ?? []).map((u: { id: string }) => u.id));
        const bad = unique.filter((id) => !existingIds.has(id));
        if (bad.length > 0) {
          return NextResponse.json(
            { error: `unknown user id${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}` },
            { status: 400 }
          );
        }
      }
      update.assigned_user_ids = unique;
      // Keep the legacy single column in sync — first id, or null.
      update.assigned_user_id = unique[0] ?? null;
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
      assignedUserId: ("assigned_user_id" in update ? (update.assigned_user_id as string | null) : undefined),
      assignedUserIds: ("assigned_user_ids" in update ? (update.assigned_user_ids as string[]) : undefined)
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
