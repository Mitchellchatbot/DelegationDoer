import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/updates/feedback?targetType=eod&targetIds=a,b,c
//   Bulk fetch reactions + replies for a list of targets. The history
//   feed renders dozens of EOD cards at once, so a single round-trip
//   (instead of N per card) keeps the page snappy.
//
// Response:
//   {
//     reactions: { [targetId]: { emoji, count, userIds[], mine }[] },
//     replies:   { [targetId]: { id, userId, userName, avatarUrl,
//                                 body, isKudos, kudosEmoji,
//                                 createdAt, editedAt, mine }[] }
//   }
export async function GET(req: NextRequest) {
  try {
    const callerId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const sp = req.nextUrl.searchParams;
    const targetType = (sp.get("targetType") ?? "").trim();
    const idsParam = sp.get("targetIds") ?? "";
    const targetIds = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 250); // cap so a typo can't blow up the query

    if (!targetType) {
      return NextResponse.json({ error: "targetType required" }, { status: 400 });
    }
    if (targetIds.length === 0) {
      return NextResponse.json({ reactions: {}, replies: {} });
    }

    const [rxRes, rpRes] = await Promise.all([
      supabase
        .from("update_reactions")
        .select("target_id, user_id, emoji")
        .eq("target_type", targetType)
        .in("target_id", targetIds),
      supabase
        .from("update_replies")
        .select("id, target_id, user_id, body, is_kudos, kudos_emoji, created_at, edited_at")
        .eq("target_type", targetType)
        .in("target_id", targetIds)
        .order("created_at", { ascending: true })
    ]);

    if (rxRes.error) {
      return NextResponse.json({ error: rxRes.error.message }, { status: 500 });
    }
    if (rpRes.error) {
      return NextResponse.json({ error: rpRes.error.message }, { status: 500 });
    }

    type RxRow = { target_id: string; user_id: string; emoji: string };
    type RpRow = {
      id: string;
      target_id: string;
      user_id: string;
      body: string;
      is_kudos: boolean;
      kudos_emoji: string | null;
      created_at: string;
      edited_at: string | null;
    };
    const rxRows = (rxRes.data ?? []) as RxRow[];
    const rpRows = (rpRes.data ?? []) as RpRow[];

    // Hydrate user names + avatars for everyone who appears in either
    // feed. One round-trip, regardless of how many rows we got back.
    const userIds = Array.from(new Set([
      ...rxRows.map((r) => r.user_id),
      ...rpRows.map((r) => r.user_id)
    ]));
    const usersById = new Map<string, { name: string; avatarUrl: string | null }>();
    if (userIds.length > 0) {
      const { data } = await supabase
        .from("users")
        .select("id, name, avatar_url")
        .in("id", userIds);
      for (const u of (data ?? []) as { id: string; name: string | null; avatar_url: string | null }[]) {
        usersById.set(u.id, { name: u.name ?? "—", avatarUrl: u.avatar_url ?? null });
      }
    }

    // Group reactions by (target, emoji) so the UI can render a chip
    // per emoji with a count + who reacted.
    const reactions: Record<string, Array<{
      emoji: string; count: number; userIds: string[]; userNames: string[]; mine: boolean;
    }>> = {};
    for (const targetId of targetIds) reactions[targetId] = [];
    const rxByKey = new Map<string, { emoji: string; targetId: string; userIds: string[]; userNames: string[] }>();
    for (const r of rxRows) {
      const key = `${r.target_id}|${r.emoji}`;
      const slot = rxByKey.get(key) ?? {
        emoji: r.emoji, targetId: r.target_id, userIds: [], userNames: []
      };
      slot.userIds.push(r.user_id);
      slot.userNames.push(usersById.get(r.user_id)?.name ?? "—");
      rxByKey.set(key, slot);
    }
    for (const slot of rxByKey.values()) {
      reactions[slot.targetId].push({
        emoji: slot.emoji,
        count: slot.userIds.length,
        userIds: slot.userIds,
        userNames: slot.userNames,
        mine: slot.userIds.includes(callerId)
      });
    }
    // Stable order: highest count first, then alphabetical emoji.
    for (const list of Object.values(reactions)) {
      list.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    }

    const replies: Record<string, Array<{
      id: string;
      userId: string;
      userName: string;
      avatarUrl: string | null;
      body: string;
      isKudos: boolean;
      kudosEmoji: string | null;
      createdAt: string;
      editedAt: string | null;
      mine: boolean;
    }>> = {};
    for (const targetId of targetIds) replies[targetId] = [];
    for (const r of rpRows) {
      const u = usersById.get(r.user_id);
      replies[r.target_id].push({
        id: r.id,
        userId: r.user_id,
        userName: u?.name ?? "—",
        avatarUrl: u?.avatarUrl ?? null,
        body: r.body,
        isKudos: r.is_kudos,
        kudosEmoji: r.kudos_emoji,
        createdAt: r.created_at,
        editedAt: r.edited_at,
        mine: r.user_id === callerId
      });
    }

    return NextResponse.json({ reactions, replies });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
