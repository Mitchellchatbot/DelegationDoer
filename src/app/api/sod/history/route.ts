import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/sod/history?days=30
//   Paginated SOD submissions, visibility-scoped:
//     - leaders + admins → see everyone
//     - dept heads      → see their dept(s)
//     - workers         → see themselves
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "no user" }, { status: 401 });

    const days = Math.min(
      180,
      Math.max(1, parseInt(new URL(req.url).searchParams.get("days") ?? "30", 10) || 30)
    );
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString().slice(0, 10);

    const supabase = getSupabaseAdmin();
    const isLeader = me.role === "leader" || me.isAdmin === true;

    let q = supabase
      .from("sod_notes")
      .select("id, user_id, note_date, top_priority, tasks_planned, blockers, submitted_at, users(name)")
      .gte("note_date", sinceIso)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(200);

    if (!isLeader) {
      // Workers + dept heads currently scoped to self. Cross-team
      // visibility can be added once roles for SOD reviewers shake out.
      q = q.eq("user_id", userId);
    }

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    type Row = {
      id: string;
      user_id: string;
      note_date: string;
      top_priority: string | null;
      tasks_planned: string | null;
      blockers: string | null;
      submitted_at: string;
      users: { name: string | null } | { name: string | null }[] | null;
    };
    return NextResponse.json({
      submissions: ((data ?? []) as Row[]).map((r) => {
        const name = Array.isArray(r.users) ? r.users[0]?.name : r.users?.name;
        return {
          id: r.id,
          userId: r.user_id,
          name: name ?? "—",
          date: r.note_date,
          topPriority: r.top_priority,
          tasksPlanned: r.tasks_planned,
          blockers: r.blockers,
          submittedAt: r.submitted_at
        };
      })
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
