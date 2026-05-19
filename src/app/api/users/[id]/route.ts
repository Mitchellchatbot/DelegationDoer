import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

const VALID_ROLES = new Set(["worker", "department_head", "leader"]);

// PATCH /api/users/[id] — leader-only edit endpoint used by the People
// tab in the Leader Console. Accepts any subset of:
//   { role: "worker" | "department_head" | "leader" }
//   { departmentIds: string[] }
//   { managerId: string | null }  // explicit reporting line for the
//                                  // org-chart team-lead tree
// and updates only the fields that were provided. Department membership
// is replaced wholesale (delete + reinsert) so the leader UI can treat
// the chip toggles as the source of truth.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const actorId = await requireCurrentUserId();
    const actor = await getUserById(actorId);
    if (!isLeader(actor)) {
      return NextResponse.json({ error: "Leader only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const supabase = getSupabaseAdmin();

    // ---- role ----
    if (typeof body.role === "string") {
      if (!VALID_ROLES.has(body.role)) {
        return NextResponse.json({ error: "invalid role" }, { status: 400 });
      }
      const { error: roleErr } = await supabase
        .from("users")
        .update({ role: body.role })
        .eq("id", params.id);
      if (roleErr) {
        return NextResponse.json(
          { error: `role update: ${roleErr.message}` },
          { status: 500 }
        );
      }
    }

    // ---- clock enabled toggle ----
    if (typeof body.clockEnabled === "boolean") {
      const { error: clockErr } = await supabase
        .from("users")
        .update({ clock_enabled: body.clockEnabled })
        .eq("id", params.id);
      if (clockErr) {
        return NextResponse.json(
          { error: `clock toggle: ${clockErr.message}` },
          { status: 500 }
        );
      }
    }

    // ---- manager (reports-to) ----
    // `null` clears it. A string sets it, but only when it points to a
    // real, distinct user — self-reference is rejected up front so a
    // bad client can't trip the DB check constraint mid-batch.
    if ("managerId" in body) {
      const raw = body.managerId;
      let managerUserId: string | null;
      if (raw === null || raw === "") {
        managerUserId = null;
      } else if (typeof raw === "string") {
        if (raw === params.id) {
          return NextResponse.json(
            { error: "managerId cannot equal the user's own id" },
            { status: 400 }
          );
        }
        const { data: exists } = await supabase
          .from("users")
          .select("id")
          .eq("id", raw)
          .maybeSingle();
        if (!exists) {
          return NextResponse.json(
            { error: "managerId references unknown user" },
            { status: 400 }
          );
        }
        managerUserId = raw;
      } else {
        return NextResponse.json(
          { error: "managerId must be a string or null" },
          { status: 400 }
        );
      }
      const { error: mErr } = await supabase
        .from("users")
        .update({ manager_user_id: managerUserId })
        .eq("id", params.id);
      if (mErr) {
        return NextResponse.json(
          { error: `manager update: ${mErr.message}` },
          { status: 500 }
        );
      }
    }

    // ---- department memberships (replace) ----
    if (Array.isArray(body.departmentIds)) {
      const departmentIds: string[] = body.departmentIds.filter(
        (s: unknown): s is string => typeof s === "string"
      );
      const { error: delErr } = await supabase
        .from("department_members")
        .delete()
        .eq("user_id", params.id);
      if (delErr) {
        return NextResponse.json(
          { error: `dept clear: ${delErr.message}` },
          { status: 500 }
        );
      }
      if (departmentIds.length > 0) {
        const rows = departmentIds.map((d) => ({
          user_id: params.id,
          department_id: d
        }));
        const { error: insErr } = await supabase
          .from("department_members")
          .upsert(rows, { onConflict: "user_id,department_id" });
        if (insErr) {
          return NextResponse.json(
            { error: `dept insert: ${insErr.message}` },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
