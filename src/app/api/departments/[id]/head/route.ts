import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PUT /api/departments/[id]/head — { headUserId: string | null }.
// Leader-only, matching the sibling [id]/slack and [id]/task-channel routes.
//
// Sets who actually runs a department. This is NOT users.role: role in DD is
// global, so someone who leads Website carries role='department_head' inside
// every department they merely belong to. head_user_id is the per-department
// answer, and it decides who auto-created work is assigned to (email and tl;dv
// intake, routing rules) and who receives the start-of-day DM from that
// department's members.
//
// null is a legitimate value meaning "nobody runs this yet" — intake then falls
// back to the skill ranker or routing review rather than guessing, and SOD
// notifies only leaders. Clearing is therefore a supported action, not an error.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !(me.role === "leader" || me.isAdmin)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    let value: string | null = null;
    if (typeof body.headUserId === "string") {
      const trimmed = body.headUserId.trim();
      value = trimmed || null;
    }

    const supabase = getSupabaseAdmin();

    // A head must actually belong to the department they lead. Everything that
    // reads head_user_id pairs it with membership (the org chart lists heads
    // among members; SOD resolves it from the submitter's departments), so a
    // non-member head would be set here and then be invisible everywhere else.
    // The FK only guarantees the user exists, not that they're on the team.
    // A leader is also rejected. Leaders render in the org chart's top tier, so
    // one named as a department's head would be drawn twice — once up there,
    // once as that column's root. Reachable today: Mitchell is role='leader'
    // and a dep_facebook member. The readers re-check this too, since a role
    // can change after the head is set.
    if (value) {
      const { data: candidate, error: mErr } = await supabase
        .from("department_members")
        .select("user_id, users!inner(role)")
        .eq("department_id", params.id)
        .eq("user_id", value)
        .maybeSingle();
      if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
      if (!candidate) {
        return NextResponse.json(
          { error: "That person isn't a member of this department — add them to it first." },
          { status: 400 }
        );
      }
      const cu = candidate as unknown as { users: { role: string } | { role: string }[] | null };
      const candidateRole = (Array.isArray(cu.users) ? cu.users[0] : cu.users)?.role;
      if (candidateRole === "leader") {
        return NextResponse.json(
          { error: "Leaders can't head a department — they already sit above every team in the org chart." },
          { status: 400 }
        );
      }
    }

    const { error } = await supabase
      .from("departments")
      .update({ head_user_id: value })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, headUserId: value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
