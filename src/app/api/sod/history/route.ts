import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/sod/history?days=30&userId=<filter>&departmentIds=a,b
//   Paginated SOD submissions, visibility-scoped:
//     - leaders + admins → see everyone
//     - everyone else    → see only themselves
//   Optional filters (leaders/admins; they can only narrow, never
//   broaden, the visibility envelope above):
//     - userId         → narrow to one person
//     - departmentIds  → narrow to members of those departments
//   Mirrors the filter contract of /api/eod/history.
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
    const sp = new URL(req.url).searchParams;
    const isLeader = me.role === "leader" || me.isAdmin === true;

    // Visibility envelope: leaders/admins see everyone (null = no
    // restriction); everyone else is scoped to themselves. Cross-team
    // visibility for dept heads is still intentionally out of scope.
    let visibleUserIds: string[] | null = isLeader ? null : [userId];

    // Optional department filter — narrow to members of the given
    // departments (intersect with the envelope above).
    const deptIds = (sp.get("departmentIds") || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (deptIds.length > 0) {
      const { data } = await supabase
        .from("department_members")
        .select("user_id")
        .in("department_id", deptIds);
      const deptUserIds = Array.from(new Set(
        ((data ?? []) as { user_id: string }[]).map((r) => r.user_id)
      ));
      if (deptUserIds.length === 0) return NextResponse.json({ submissions: [] });
      visibleUserIds = visibleUserIds === null
        ? deptUserIds
        : visibleUserIds.filter((id) => deptUserIds.includes(id));
    }

    // Optional userId filter, validated against the visible set.
    const userIdFilter = sp.get("userId") || null;
    if (userIdFilter) {
      if (visibleUserIds && !visibleUserIds.includes(userIdFilter)) {
        return NextResponse.json({ submissions: [] });
      }
      visibleUserIds = [userIdFilter];
    }

    let q = supabase
      .from("sod_notes")
      .select("id, user_id, note_date, top_priority, tasks_planned, blockers, submitted_at, users(name)")
      .gte("note_date", sinceIso)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(200);

    if (visibleUserIds !== null) {
      if (visibleUserIds.length === 0) return NextResponse.json({ submissions: [] });
      q = q.in("user_id", visibleUserIds);
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
