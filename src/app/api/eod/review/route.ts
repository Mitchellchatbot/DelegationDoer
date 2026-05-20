import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// POST /api/eod/review
//   body: { userId: string, date?: "YYYY-MM-DD", undo?: boolean }
//   Marks a worker's EOD as reviewed by the caller — only allowed if
//   the caller is a leader, an admin, or a department_head of any
//   department the target worker belongs to. Mitch can see who ticked
//   it off via the resulting reviewed_by field.

export async function POST(req: NextRequest) {
  try {
    const callerId = await requireCurrentUserId();
    const caller = await getUserById(callerId);
    if (!caller) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const targetUserId = typeof body.userId === "string" ? body.userId : "";
    if (!targetUserId) return NextResponse.json({ error: "userId required" }, { status: 400 });
    const dateStr =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date().toISOString().slice(0, 10);
    const undo = body.undo === true;

    // Permission gate: leaders/admins always, dept heads only for
    // workers in a dept they head.
    const supabase = getSupabaseAdmin();
    const isLeader = caller.role === "leader" || caller.isAdmin === true;
    let allowed = isLeader;
    if (!allowed && caller.role === "department_head") {
      const myDepts = new Set(caller.departmentIds ?? []);
      const { data } = await supabase
        .from("department_members")
        .select("department_id")
        .eq("user_id", targetUserId);
      const targetDepts = new Set(((data ?? []) as { department_id: string }[]).map((r) => r.department_id));
      for (const d of myDepts) {
        if (targetDepts.has(d)) { allowed = true; break; }
      }
    }
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("eod_notes")
      .update(undo
        ? { reviewed_at: null, reviewed_by: null }
        : { reviewed_at: now, reviewed_by: callerId }
      )
      .eq("user_id", targetUserId)
      .eq("note_date", dateStr);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      reviewedAt: undo ? null : now,
      reviewedBy: undo ? null : callerId
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
