import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// PATCH /api/todo-lists/[id]
//   body: { title?: string }
//   Rename a list. Any leader can rename any leader-owned or shared
//   list (equal-authority model); the auto-seeded Today / Long-term
//   are also fair game.
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
    const update: Record<string, unknown> = {};
    if (typeof body.title === "string") {
      const t = body.title.trim().slice(0, 80);
      if (!t) return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
      update.title = t;
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    const { error } = await getSupabaseAdmin()
      .from("todo_lists")
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

// DELETE /api/todo-lists/[id]
//   Deletes the list + cascades to its items. Protected: can't
//   delete the singleton shared list or the seeded today / longterm
//   ones (those are stable parts of the UI). Custom lists only.
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
    const supabase = getSupabaseAdmin();
    const { data: list } = await supabase
      .from("todo_lists")
      .select("kind")
      .eq("id", params.id)
      .maybeSingle();
    if (!list) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (list.kind !== "custom") {
      return NextResponse.json(
        { error: "only custom lists can be deleted" },
        { status: 400 }
      );
    }
    const { error } = await supabase
      .from("todo_lists")
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
