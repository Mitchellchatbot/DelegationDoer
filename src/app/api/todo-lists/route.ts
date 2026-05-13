import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET /api/todo-lists
//   Returns every list the leader can see: their own, the shared
//   workspace list, and every other leader's lists. Auto-creates
//   "Today" + "Long-term" for the caller on first access so the UI
//   always has something to render.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const supabase = getSupabaseAdmin();

    // Auto-seed today / long-term for this leader if absent.
    const { data: mine } = await supabase
      .from("todo_lists")
      .select("id, kind")
      .eq("owner_id", userId);
    const haveToday = (mine ?? []).some((l) => l.kind === "today");
    const haveLong = (mine ?? []).some((l) => l.kind === "longterm");
    const seeds: { owner_id: string; title: string; kind: string; position: number }[] = [];
    if (!haveToday) seeds.push({ owner_id: userId, title: "Today", kind: "today", position: 1 });
    if (!haveLong)  seeds.push({ owner_id: userId, title: "Long-term", kind: "longterm", position: 2 });
    if (seeds.length) await supabase.from("todo_lists").insert(seeds);

    // All leaders (for grouping in the sidebar).
    const { data: leaders } = await supabase
      .from("users")
      .select("id, name, avatar_url")
      .eq("role", "leader");

    // Lists: shared + every leader's. Workers' lists don't exist
    // because we gate creation, but be safe and only return
    // owner_id IN (leader ids) or owner_id IS NULL.
    const leaderIds = (leaders ?? []).map((l) => l.id as string);
    const { data: lists } = await supabase
      .from("todo_lists")
      .select("id, owner_id, title, kind, position, updated_at")
      .or(`owner_id.is.null,owner_id.in.(${leaderIds.length ? leaderIds.join(",") : "_none_"})`)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    // Item counts in one round-trip via a separate aggregate query.
    const listIds = (lists ?? []).map((l) => l.id as string);
    type Counts = { list_id: string; open: number; done: number };
    const counts: Counts[] = [];
    if (listIds.length > 0) {
      const { data: itemsRaw } = await supabase
        .from("todo_items")
        .select("list_id, done")
        .in("list_id", listIds);
      const byList = new Map<string, { open: number; done: number }>();
      for (const r of (itemsRaw ?? []) as { list_id: string; done: boolean }[]) {
        const cur = byList.get(r.list_id) ?? { open: 0, done: 0 };
        if (r.done) cur.done++; else cur.open++;
        byList.set(r.list_id, cur);
      }
      for (const [list_id, c] of byList.entries()) {
        counts.push({ list_id, open: c.open, done: c.done });
      }
    }
    const countsByList = new Map(counts.map((c) => [c.list_id, c]));

    return NextResponse.json({
      lists: (lists ?? []).map((l) => ({
        id: l.id,
        ownerId: l.owner_id,
        title: l.title,
        kind: l.kind,
        position: l.position,
        updatedAt: l.updated_at,
        openCount: countsByList.get(l.id as string)?.open ?? 0,
        doneCount: countsByList.get(l.id as string)?.done ?? 0
      })),
      leaders: (leaders ?? []).map((l) => ({
        id: l.id,
        name: l.name,
        avatarUrl: l.avatar_url ?? null
      })),
      meId: userId
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/todo-lists
//   body: { title: string }
//   Creates a custom personal list owned by the caller.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
    if (!title) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("todo_lists")
      .insert({ owner_id: userId, title, kind: "custom", position: 100 })
      .select("id, owner_id, title, kind, position, updated_at")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ list: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
