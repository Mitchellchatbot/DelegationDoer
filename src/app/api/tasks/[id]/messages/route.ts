import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/tasks/[id]/messages — thread messages, oldest → newest.
// POST /api/tasks/[id]/messages — append a message. Body: { body, imageUrl? }.
// Threads are deliberately separate from activity_logs so chat conversations
// don't get buried under noisy status_change / handoff entries.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("task_messages")
    .select("id, task_id, user_id, body, image_url, created_at")
    .eq("task_id", params.id)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: data ?? [] });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const text = typeof body.body === "string" ? body.body.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() || null : null;
    if (!text && !imageUrl) {
      return NextResponse.json({ error: "message body or image required" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("task_messages")
      .insert({
        id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        task_id: params.id,
        user_id: userId,
        body: text || "(image)",
        image_url: imageUrl
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Touch task last_activity_at so the thread bumps the task in feeds.
    await supabase
      .from("tasks")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", params.id);
    return NextResponse.json({ message: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
