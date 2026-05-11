import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/clock/entries — list the current user's segments. By default
// returns today's; pass ?since=ISO to widen. Includes the resolved task
// title so the manual-fix UI can render "Worked on X" without an extra
// query.
export async function GET(req: Request) {
  const userId = await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);

  const sinceParam = url.searchParams.get("since");
  let sinceIso: string;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    sinceIso = Number.isNaN(parsed.getTime())
      ? defaultSince()
      : parsed.toISOString();
  } else {
    sinceIso = defaultSince();
  }

  const { data: rows, error } = await supabase
    .from("time_entries")
    .select("id, started_at, ended_at, task_id, note")
    .eq("user_id", userId)
    .gte("started_at", sinceIso)
    .order("started_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const taskIds = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.task_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  );
  let titleById = new Map<string, string>();
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase
      .from("tasks")
      .select("id, title")
      .in("id", taskIds);
    titleById = new Map((tasks ?? []).map((t) => [t.id as string, t.title as string]));
  }

  const entries = (rows ?? []).map((r) => ({
    id: r.id as string,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    taskTitle: r.task_id ? titleById.get(r.task_id as string) ?? null : null,
    note: (r.note as string | null) ?? null
  }));

  return NextResponse.json({ entries });
}

function defaultSince(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
