import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

// GET /api/notifications — the viewer's recent mention / notify-teammates
// pings. Returns both seen and unseen, sorted newest first. The topbar
// bell renders these in a popover. /api/widget/my-tasks already serves
// the live feed for the desktop widget; this endpoint exists so the
// in-app bell can show ack'd notifications too (history), not just
// unseen ones.

export const dynamic = "force-dynamic";

const LIMIT = 25;

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: rows, error } = await supabase
      .from("task_notifications")
      .select("id, task_id, kind, note, from_user_id, created_at, seen_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const taskIds = Array.from(new Set((rows ?? []).map((n) => n.task_id as string)));
    const fromIds = Array.from(new Set(
      (rows ?? [])
        .map((n) => n.from_user_id as string | null)
        .filter((v): v is string => !!v)
    ));

    const [{ data: tasks }, { data: senders }] = await Promise.all([
      taskIds.length > 0
        ? supabase.from("tasks").select("id, title").in("id", taskIds)
        : Promise.resolve({ data: [] as { id: string; title: string }[] }),
      fromIds.length > 0
        ? supabase.from("users").select("id, name, avatar_url").in("id", fromIds)
        : Promise.resolve({ data: [] as { id: string; name: string; avatar_url: string | null }[] })
    ]);
    const taskById = new Map((tasks ?? []).map((t) => [t.id as string, t.title as string]));
    const senderById = new Map(
      (senders ?? []).map((u) => [u.id as string, { name: u.name as string, avatarUrl: (u.avatar_url as string | null) ?? null }])
    );

    const notifications = (rows ?? []).map((n) => ({
      id: n.id as string,
      taskId: n.task_id as string,
      taskTitle: taskById.get(n.task_id as string) ?? "Task",
      kind: n.kind as "mention" | "notified",
      note: (n.note as string | null) ?? null,
      from: (n.from_user_id as string | null)
        ? senderById.get(n.from_user_id as string) ?? null
        : null,
      createdAt: n.created_at as string,
      seenAt: (n.seen_at as string | null) ?? null
    }));

    const unseenCount = notifications.filter((n) => !n.seenAt).length;
    return NextResponse.json({ notifications, unseenCount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/notifications/mark-all-seen — flip every unseen row for
// the viewer to seen_at=now(). Used by the bell's "Mark all read"
// affordance + auto-firing when the user opens the popover.
export async function POST() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("task_notifications")
      .update({ seen_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("seen_at", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
