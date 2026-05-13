import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET /api/projects/updates — leader-only. Recent activity rolled up
// across every project: tasks that changed status, stages that
// advanced, new projects opened. We surface the last N events plus
// an `unseenCount` computed against the user's
// projects_updates_seen_at marker so the UI can show a badge.
//
// "Activity" = anything whose last_activity_at (tasks) or updated_at
// (stages/projects) is newer than the user's marker.
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const supabase = getSupabaseAdmin();

    const { data: meRow } = await supabase
      .from("users")
      .select("projects_updates_seen_at")
      .eq("id", userId)
      .maybeSingle();
    const seenAt = (meRow?.projects_updates_seen_at as string | null) ?? null;
    const seenMs = seenAt ? new Date(seenAt).getTime() : 0;

    const limit = Math.max(
      5,
      Math.min(60, Number(req.nextUrl.searchParams.get("limit") || 25))
    );

    // Pull recent rows from each source, normalize into one event
    // stream, sort by timestamp desc, and slice to the limit. Cheap
    // because each query has a covering index on its own table.
    const [taskRes, stageRes, projectRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, title, status, project_id, last_activity_at, assignee_id")
        .not("project_id", "is", null)
        .order("last_activity_at", { ascending: false })
        .limit(limit),
      supabase
        .from("project_stages")
        .select("id, project_id, name, status, updated_at")
        .order("updated_at", { ascending: false })
        .limit(limit),
      supabase
        .from("projects")
        .select("id, name, created_at")
        .order("created_at", { ascending: false })
        .limit(limit)
    ]);

    const projectIds = Array.from(
      new Set([
        ...(taskRes.data ?? []).map((t) => t.project_id as string).filter(Boolean),
        ...(stageRes.data ?? []).map((s) => s.project_id as string).filter(Boolean),
        ...(projectRes.data ?? []).map((p) => p.id as string).filter(Boolean)
      ])
    );
    const { data: projectsList } = await supabase
      .from("projects")
      .select("id, name")
      .in("id", projectIds.length > 0 ? projectIds : ["_none_"]);
    const projectNameById = new Map(
      (projectsList ?? []).map((p) => [p.id as string, p.name as string])
    );

    const userIds = Array.from(
      new Set((taskRes.data ?? []).map((t) => t.assignee_id as string).filter(Boolean))
    );
    const { data: usersList } = await supabase
      .from("users")
      .select("id, name")
      .in("id", userIds.length > 0 ? userIds : ["_none_"]);
    const userNameById = new Map(
      (usersList ?? []).map((u) => [u.id as string, u.name as string])
    );

    type Event = {
      kind: "task" | "stage" | "project";
      at: string;
      projectId: string;
      projectName: string;
      title: string;
      detail: string;
      taskId?: string;
    };

    const events: Event[] = [];
    for (const t of taskRes.data ?? []) {
      const at = t.last_activity_at as string;
      if (!at) continue;
      const projectName = projectNameById.get(t.project_id as string) ?? "(unknown project)";
      const assigneeName = t.assignee_id
        ? userNameById.get(t.assignee_id as string) ?? null
        : null;
      const status = (t.status as string) || "pending";
      const detail = assigneeName
        ? `${assigneeName} · ${status.replace(/_/g, " ")}`
        : status.replace(/_/g, " ");
      events.push({
        kind: "task",
        at,
        projectId: t.project_id as string,
        projectName,
        title: t.title as string,
        detail,
        taskId: t.id as string
      });
    }
    for (const s of stageRes.data ?? []) {
      const at = s.updated_at as string;
      if (!at) continue;
      const projectName = projectNameById.get(s.project_id as string) ?? "(unknown project)";
      events.push({
        kind: "stage",
        at,
        projectId: s.project_id as string,
        projectName,
        title: `Stage "${s.name}"`,
        detail: `now ${s.status}`
      });
    }
    for (const p of projectRes.data ?? []) {
      const at = p.created_at as string;
      if (!at) continue;
      events.push({
        kind: "project",
        at,
        projectId: p.id as string,
        projectName: p.name as string,
        title: `New project · ${p.name}`,
        detail: "created"
      });
    }

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const top = events.slice(0, limit);

    const unseenCount = events.filter(
      (e) => new Date(e.at).getTime() > seenMs
    ).length;

    return NextResponse.json({
      events: top,
      unseenCount,
      seenAt
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
