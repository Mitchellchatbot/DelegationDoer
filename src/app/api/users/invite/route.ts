import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isCeo } from "@/lib/access";

export const dynamic = "force-dynamic";

// POST /api/users/invite — CEO-only. Body:
//   { name, email, role: "worker"|"department_head"|"ceo", departmentIds: string[] }
// Sends a Supabase Auth invite email (magic link). On accept the
// existing on_auth_user_created trigger creates the public.users
// row; we proactively upsert the name + role + department memberships
// keyed on the auth user id so the invitee shows up in the org chart
// immediately, not just after they sign in.
//
// Multiple heads per department is fully supported — we don't demote
// any existing head when adding a new one. The data model already
// allows N users to each have role='department_head' + the same
// department in department_members.

const VALID_ROLES = new Set(["worker", "department_head", "ceo"]);

export async function POST(req: NextRequest) {
  try {
    const actorId = await requireCurrentUserId();
    const actor = await getUserById(actorId);
    if (!isCeo(actor)) {
      return NextResponse.json({ error: "CEO only" }, { status: 403 });
    }

    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" ? body.role : "";
    const departmentIds: string[] = Array.isArray(body.departmentIds)
      ? body.departmentIds.filter((s: unknown): s is string => typeof s === "string")
      : [];
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "valid email required" }, { status: 400 });
    }
    if (!VALID_ROLES.has(role)) {
      return NextResponse.json({ error: "invalid role" }, { status: 400 });
    }
    if (role === "department_head" && departmentIds.length === 0) {
      return NextResponse.json(
        { error: "department head needs at least one department" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();

    // 1) Has anyone with this email already been created? If so we
    //    skip the auth invite (Supabase 422s on duplicates) and just
    //    upsert the role / department memberships.
    let authUserId: string | null = null;
    let invitedNew = false;

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .ilike("email", email)
      .maybeSingle();
    if (existing) {
      authUserId = existing.id as string;
    } else {
      // Send the actual invite. supabase.auth.admin.inviteUserByEmail
      // creates an auth.users row + emails a magic link. The trigger
      // mirrors into public.users with id = auth.users.id.
      try {
        const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
          data: { name }
        });
        if (error) throw error;
        authUserId = data?.user?.id ?? null;
        invitedNew = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          { error: `invite failed: ${msg}` },
          { status: 500 }
        );
      }
    }

    if (!authUserId) {
      return NextResponse.json(
        { error: "couldn't resolve invitee user id" },
        { status: 500 }
      );
    }

    // 2) Upsert the public.users row with the role + name. The trigger
    //    creates a minimal row; we top it up. Existing users get their
    //    role updated (which is the whole point of re-inviting).
    const { error: upErr } = await supabase
      .from("users")
      .upsert(
        {
          id: authUserId,
          name,
          email,
          role,
          daily_capacity: 8,
          throughput: {},
          skills: []
        },
        { onConflict: "id" }
      );
    if (upErr) {
      return NextResponse.json(
        { error: `users upsert: ${upErr.message}` },
        { status: 500 }
      );
    }

    // 3) Replace department memberships. For workers + heads we set
    //    the exact list passed in (empty list = no memberships).
    //    Multiple heads per dept fall out naturally because nothing
    //    in the schema unique-keys by department_id alone.
    await supabase.from("department_members").delete().eq("user_id", authUserId);
    if (departmentIds.length > 0) {
      const inserts = departmentIds.map((dId) => ({
        id: `dm_${authUserId}_${dId}`,
        user_id: authUserId,
        department_id: dId
      }));
      const { error: dmErr } = await supabase.from("department_members").upsert(inserts);
      if (dmErr) {
        return NextResponse.json(
          { error: `department membership: ${dmErr.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      ok: true,
      userId: authUserId,
      email,
      role,
      departmentIds,
      invitedNew,
      message: invitedNew
        ? "Invite email sent — they'll show up here once they accept."
        : "User already existed; role and departments updated."
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
