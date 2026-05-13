import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// PATCH /api/todo-items/[id]
//   body: { content?: string, done?: boolean }
//   Toggle done state or edit text. Any leader can edit any item
//   (equal-authority model).
export async function PATCH(
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
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.content === "string") {
      const c = body.content.trim().slice(0, 500);
      if (!c) return NextResponse.json({ error: "content cannot be empty" }, { status: 400 });
      update.content = c;
    }
    if (typeof body.done === "boolean") {
      update.done = body.done;
      update.done_at = body.done ? new Date().toISOString() : null;
    }
    if (Object.keys(update).length === 1) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    const { error } = await getSupabaseAdmin()
      .from("todo_items")
      .update(update)
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/todo-items/[id]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const { error } = await getSupabaseAdmin()
      .from("todo_items")
      .delete()
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
