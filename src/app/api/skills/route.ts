import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

interface SkillRow {
  id: string;
  user_id: string;
  tag: string;
  manual_level: number;
  auto_score: number;
  task_count: number;
  last_practiced_at: string | null;
  updated_at: string;
}

// Anyone can read the skills matrix — useful for tooltips, ranking
// suggestions, etc. Writes are scoped per-call: managers can edit anyone,
// everyone else can only edit their own row. Resolved by the caller.
async function authContext(): Promise<{ userId: string; isManager: boolean }> {
  const userId = await requireCurrentUserId();
  const u = await getUserById(userId);
  return {
    userId,
    isManager: !!u && (u.role === "leader" || u.role === "department_head" || u.isAdmin === true)
  };
}

function rowToJson(r: SkillRow) {
  return {
    id: r.id,
    userId: r.user_id,
    tag: r.tag,
    manualLevel: r.manual_level,
    autoScore: Number(r.auto_score),
    taskCount: r.task_count,
    lastPracticedAt: r.last_practiced_at,
    // Combined score the delegation engine reads. Tuned so a manual L1 is
    // worth ~6 task completions, L5 ~30. Keeps manual entries meaningful
    // even after a lot of automated activity accumulates.
    combinedScore: r.manual_level * 6 + Number(r.auto_score)
  };
}

// GET /api/skills — every (user, tag) row. Optional ?userId= filter.
export async function GET(req: NextRequest) {
  await requireCurrentUserId();
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  const supabase = getSupabaseAdmin();
  let q = supabase.from("user_skills").select("*").order("auto_score", { ascending: false });
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    skills: ((data ?? []) as SkillRow[]).map(rowToJson)
  });
}

// POST /api/skills — upsert manual_level. Body: { userId, tag, manualLevel }.
// Self-edits always allowed; managers can edit anyone. Auto-scores aren't
// writable from this endpoint (those move via the task-completion handler).
export async function POST(req: NextRequest) {
  const { userId: meId, isManager } = await authContext();
  const body = await req.json();
  const userId = typeof body.userId === "string" ? body.userId : "";
  const tag = typeof body.tag === "string" ? body.tag.trim().toLowerCase() : "";
  const manualLevel = Number(body.manualLevel ?? 0);
  if (!userId || !tag) {
    return NextResponse.json({ error: "userId + tag required" }, { status: 400 });
  }
  if (!isManager && userId !== meId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!Number.isInteger(manualLevel) || manualLevel < 0 || manualLevel > 5) {
    return NextResponse.json({ error: "manualLevel must be 0-5" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  // Upsert by (user_id, tag) unique key. Read existing first so we can
  // generate a new id only when no row exists.
  const { data: existing } = await supabase
    .from("user_skills")
    .select("id")
    .eq("user_id", userId)
    .eq("tag", tag)
    .maybeSingle();
  const id = existing?.id ?? `us_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${tag.slice(0, 8)}`;
  const { data, error } = await supabase
    .from("user_skills")
    .upsert(
      {
        id,
        user_id: userId,
        tag,
        manual_level: manualLevel,
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id,tag" }
    )
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ skill: rowToJson(data as SkillRow) });
}

// DELETE /api/skills?id= — drop a skill row. Self-edits allowed when the
// row's user_id matches the caller; managers can drop anyone's.
export async function DELETE(req: NextRequest) {
  const { userId: meId, isManager } = await authContext();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const supabase = getSupabaseAdmin();
  // Look up the owning user before deleting — cheap and lets us return a
  // useful error rather than silently no-op.
  const { data: row } = await supabase
    .from("user_skills")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!isManager && row.user_id !== meId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { error } = await supabase.from("user_skills").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
