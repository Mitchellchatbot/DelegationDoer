import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET /api/todo-lists/[id]/items
//   Returns every item in the list, ordered by done (open first)
//   then position then created_at.
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("todo_items")
      .select("id, content, done, position, created_at, updated_at, done_at, created_by")
      .eq("list_id", params.id)
      .order("done", { ascending: true })
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      items: (data ?? []).map((r) => ({
        id: r.id,
        content: r.content,
        done: r.done,
        position: r.position,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        doneAt: r.done_at,
        createdBy: r.created_by
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/todo-lists/[id]/items
//   body: { content: string }
//   Add an item. Position auto-assigned to (max+1).
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const { data: max } = await supabase
      .from("todo_items")
      .select("position")
      .eq("list_id", params.id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const position = ((max?.position as number) ?? 0) + 1;
    const { data, error } = await supabase
      .from("todo_items")
      .insert({
        list_id: params.id,
        content: content.slice(0, 500),
        position,
        created_by: userId
      })
      .select("id, content, done, position, created_at, updated_at, done_at, created_by")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      item: {
        id: data.id,
        content: data.content,
        done: data.done,
        position: data.position,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        doneAt: data.done_at,
        createdBy: data.created_by
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
