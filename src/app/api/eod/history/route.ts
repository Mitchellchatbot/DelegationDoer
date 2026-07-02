import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/eod/history?days=30&userId=<filter>&departmentIds=a,b
//   Returns a flat chronological list of every submitted EOD the
//   caller is allowed to see. Powers the EOD history feed at
//   /updates/eod/history and the leader-console "Day reports" tab.
//
//   Visibility:
//     - leaders + admins   → every submission
//     - department_heads   → submissions by anyone in a dept they head,
//                            plus their own
//     - workers            → submissions by anyone in a department they
//                            belong to, plus their own (self-only if they
//                            have no department)
//
//   Optional filters (applied on top of visibility, never broaden it):
//     - userId         → narrow to one person
//     - departmentIds  → narrow to members of those departments
//
//   Only rows with submitted_at IS NOT NULL are included — autosaved
//   drafts that the worker never finalized don't pollute the feed.

interface EodRow {
  id: string;
  user_id: string;
  note_date: string;
  worked_on: string | null;
  accomplished: string | null;
  plan_tomorrow: string | null;
  blockers: string | null;
  leads_messaged: string | null;
  linkedin_comments: string | null;
  note: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export async function GET(req: NextRequest) {
  try {
    const callerId = await requireCurrentUserId();
    const me = await getUserById(callerId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const sp = req.nextUrl.searchParams;
    const daysParam = parseInt(sp.get("days") ?? "30", 10);
    const days = Math.min(180, Math.max(1, Number.isNaN(daysParam) ? 30 : daysParam));
    const userIdFilter = sp.get("userId") || null;

    // Compute the date range. note_date is a date column, so we
    // compare against YYYY-MM-DD strings.
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString().slice(0, 10);

    // Resolve who the caller can see.
    const isLeader = me.role === "leader" || me.isAdmin === true;
    let visibleUserIds: string[] | null = null; // null = no restriction (leader)

    if (isLeader) {
      visibleUserIds = null;
    } else if ((me.departmentIds ?? []).length > 0) {
      // Non-leaders (workers + dept heads) see submissions by anyone in a
      // department they belong to, plus their own.
      const { data } = await supabase
        .from("department_members")
        .select("user_id")
        .in("department_id", me.departmentIds ?? []);
      const ids = Array.from(new Set(
        ((data ?? []) as { user_id: string }[]).map((r) => r.user_id)
      ));
      // Always include the caller so they see their own past submissions too.
      if (!ids.includes(callerId)) ids.push(callerId);
      visibleUserIds = ids;
    } else {
      // No department — only their own.
      visibleUserIds = [callerId];
    }

    // Optional department filter — narrow to members of the given
    // departments (intersect with what the caller can already see).
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

    // Apply optional userId filter on top of visibility.
    if (userIdFilter) {
      if (visibleUserIds && !visibleUserIds.includes(userIdFilter)) {
        return NextResponse.json({ submissions: [] });
      }
      visibleUserIds = [userIdFilter];
    }

    let q = supabase
      .from("eod_notes")
      .select("id, user_id, note_date, worked_on, accomplished, plan_tomorrow, blockers, leads_messaged, linkedin_comments, note, submitted_at, reviewed_at, reviewed_by")
      .not("submitted_at", "is", null)
      .gte("note_date", sinceIso)
      .order("submitted_at", { ascending: false })
      .limit(500);

    if (visibleUserIds !== null) {
      if (visibleUserIds.length === 0) return NextResponse.json({ submissions: [] });
      q = q.in("user_id", visibleUserIds);
    }

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []) as EodRow[];

    // Hydrate user names in one round-trip.
    const userIds = Array.from(new Set([
      ...rows.map((r) => r.user_id),
      ...rows.map((r) => r.reviewed_by).filter((v): v is string => !!v)
    ]));
    const usersById = new Map<string, { name: string; avatarUrl: string | null }>();
    if (userIds.length > 0) {
      const { data: us } = await supabase
        .from("users")
        .select("id, name, avatar_url")
        .in("id", userIds);
      for (const u of (us ?? []) as { id: string; name: string | null; avatar_url: string | null }[]) {
        usersById.set(u.id, { name: u.name ?? "—", avatarUrl: u.avatar_url ?? null });
      }
    }

    // Attach the per-client EOD work each person logged (the new
    // client-by-client flow), keyed by user_id|note_date so it lands on
    // the matching submission card. Best-effort: a missing table just
    // yields no client work.
    const clientWorkByKey = new Map<string, Array<{ clientName: string; workedOn: string; results: string | null }>>();
    const submitterIds = Array.from(new Set(rows.map((r) => r.user_id)));
    if (submitterIds.length > 0) {
      const { data: workRows, error: workErr } = await supabase
        .from("eod_client_work")
        .select("user_id, note_date, client_name, worked_on, results")
        .in("user_id", submitterIds)
        .gte("note_date", sinceIso)
        .order("created_at", { ascending: true });
      if (workErr) {
        if (!/eod_client_work/.test(workErr.message)) {
          console.error("[eod/history] client-work lookup", workErr);
        }
      } else {
        for (const w of (workRows ?? []) as Array<{ user_id: string; note_date: string; client_name: string; worked_on: string; results: string | null }>) {
          const key = `${w.user_id}|${w.note_date}`;
          const arr = clientWorkByKey.get(key) ?? [];
          arr.push({ clientName: w.client_name, workedOn: w.worked_on, results: w.results });
          clientWorkByKey.set(key, arr);
        }
      }
    }

    return NextResponse.json({
      submissions: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        name: usersById.get(r.user_id)?.name ?? "—",
        avatarUrl: usersById.get(r.user_id)?.avatarUrl ?? null,
        date: r.note_date,
        workedOn: r.worked_on,
        accomplished: r.accomplished,
        planTomorrow: r.plan_tomorrow,
        blockers: r.blockers,
        leadsMessaged: r.leads_messaged,
        linkedinComments: r.linkedin_comments,
        note: r.note && r.note.trim() ? r.note : null,
        clientWork: clientWorkByKey.get(`${r.user_id}|${r.note_date}`) ?? [],
        submittedAt: r.submitted_at,
        reviewedAt: r.reviewed_at,
        reviewedBy: r.reviewed_by
          ? { id: r.reviewed_by, name: usersById.get(r.reviewed_by)?.name ?? "—" }
          : null
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
