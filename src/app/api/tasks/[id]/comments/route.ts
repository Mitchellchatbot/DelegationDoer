import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/comments — add a comment as an activity_log row.
// Body: { content: string }.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const userId = access.viewerId;
    const { content, imageUrl } = await req.json();
    const text = (content ?? "").trim();
    const image = typeof imageUrl === "string" ? imageUrl : null;
    if (!text && !image) {
      return NextResponse.json({ error: "content or imageUrl required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("activity_logs")
      .insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        user_id: userId,
        action: "comment",
        detail: text || null,
        image_url: image
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Bump the task's last_activity_at so it doesn't get marked stalled.
    await supabase.from("tasks").update({ last_activity_at: now, inactive_flag: false }).eq("id", params.id);

    return NextResponse.json({ comment: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
