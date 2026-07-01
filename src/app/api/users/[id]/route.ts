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

    // ---- SOD/EOD popup forms toggle ----
    // Flips daily_prompts_required, which force-opts a privileged account
    // (leader/admin) back into the SOD modal + /home bookend despite the
    // role exemption. The console only exposes this switch on leader/admin
    // rows, but the column is safe to set on anyone.
    if (typeof body.dailyPromptsRequired === "boolean") {
      const { error: promptsErr } = await supabase
        .from("users")
        .update({ daily_prompts_required: body.dailyPromptsRequired })
        .eq("id", params.id);
      if (promptsErr) {
        return NextResponse.json(
          { error: `forms toggle: ${promptsErr.message}` },
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
      // If the chosen primary is currently this user's SECONDARY manager, a
      // plain update would momentarily set primary == secondary and trip
      // users_secondary_manager_not_primary. Resolve it atomically by
      // swapping: promote the co-lead to primary and demote the old primary
      // to secondary (no one is silently dropped). Both columns differ in the
      // single write, so the check constraint is satisfied.
      const managerPatch: {
        manager_user_id: string | null;
        secondary_manager_user_id?: string | null;
      } = { manager_user_id: managerUserId };
      if (managerUserId !== null) {
        const { data: current } = await supabase
          .from("users")
          .select("manager_user_id, secondary_manager_user_id")
          .eq("id", params.id)
          .maybeSingle();
        if (current?.secondary_manager_user_id === managerUserId) {
          managerPatch.secondary_manager_user_id = current.manager_user_id ?? null;
        }
      }
      const { error: mErr } = await supabase
        .from("users")
        .update(managerPatch)
        .eq("id", params.id);
      if (mErr) {
        return NextResponse.json(
          { error: `manager update: ${mErr.message}` },
          { status: 500 }
        );
      }
    }

    // ---- secondary manager (co-report) ----
    // Same shape as `managerId` — null clears, string sets after the
    // existence/self check. Don't bother validating against the primary
    // here: the DB has a not-equal check constraint, so a redundant
    // assignment is caught at write time with a clear error.
    if ("secondaryManagerId" in body) {
      const raw = body.secondaryManagerId;
      let secondaryUserId: string | null;
      if (raw === null || raw === "") {
        secondaryUserId = null;
      } else if (typeof raw === "string") {
        if (raw === params.id) {
          return NextResponse.json(
            { error: "secondaryManagerId cannot equal the user's own id" },
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
            { error: "secondaryManagerId references unknown user" },
            { status: 400 }
          );
        }
        secondaryUserId = raw;
      } else {
        return NextResponse.json(
          { error: "secondaryManagerId must be a string or null" },
          { status: 400 }
        );
      }
      const { error: sErr } = await supabase
        .from("users")
        .update({ secondary_manager_user_id: secondaryUserId })
        .eq("id", params.id);
      if (sErr) {
        return NextResponse.json(
          { error: `secondary manager update: ${sErr.message}` },
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

// DELETE /api/users/[id] — leader/admin-only off-board. Hard-deletes the
// teammate and their login. The messy part (FK blockers + array columns
// + auth.users) lives in the transactional public.offboard_user() SQL
// function; here we just gate access, apply the two safety rails that
// need app context (no self-delete, don't strand the console with zero
// leaders), run the purge, then remove the Supabase Auth login so the
// handle_new_auth_user() trigger can't resurrect the row on next sign-in.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const actorId = await requireCurrentUserId();
    const actor = await getUserById(actorId);
    if (!isLeader(actor)) {
      return NextResponse.json({ error: "Leader only" }, { status: 403 });
    }
    if (params.id === actorId) {
      return NextResponse.json(
        { error: "You can't off-board yourself." },
        { status: 400 }
      );
    }

    const target = await getUserById(params.id);
    if (!target) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }

    const supabase = getSupabaseAdmin();

    // Don't let the last leader be removed — that would lock everyone out
    // of the console. Stealth admins (is_admin) don't count as leaders for
    // this check because their public role can be anything; we specifically
    // guard the visible leadership seat.
    if (target.role === "leader") {
      const { count, error: cErr } = await supabase
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("role", "leader");
      if (cErr) {
        return NextResponse.json(
          { error: `leader count: ${cErr.message}` },
          { status: 500 }
        );
      }
      if ((count ?? 0) <= 1) {
        return NextResponse.json(
          { error: "Can't off-board the last leader." },
          { status: 400 }
        );
      }
    }

    // Atomic purge. Authored tasks are reassigned to the actor so no task
    // history is lost. Returns the target's auth.users id (may be null).
    const { data: authUserId, error: rpcErr } = await supabase.rpc(
      "offboard_user",
      { target_user_id: params.id, successor_user_id: actorId }
    );
    if (rpcErr) {
      return NextResponse.json(
        { error: `offboard: ${rpcErr.message}` },
        { status: 500 }
      );
    }

    // Remove the login. Best-effort: the app row is already gone, and a
    // stray auth row only matters if they try to sign in again — surface
    // it in the response rather than failing the whole off-board.
    let authDeleteError: string | null = null;
    if (typeof authUserId === "string" && authUserId) {
      const { error: aErr } = await supabase.auth.admin.deleteUser(authUserId);
      if (aErr) authDeleteError = aErr.message;
    }

    return NextResponse.json({ ok: true, authDeleteError });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
