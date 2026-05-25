import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/updates/replies
//   body: {
//     targetType: string,
//     targetId: string,
//     body: string,
//     isKudos?: boolean,
//     kudosEmoji?: string
//   }
//
// Adds a reply / comment on an update. When isKudos=true, the reply
// renders with a recognition ribbon + the chosen emoji — that's how
// "Great job!" preset replies stand out from plain comments.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const payload = await req.json().catch(() => ({}));

    const targetType = typeof payload.targetType === "string" ? payload.targetType.trim() : "";
    const targetId = typeof payload.targetId === "string" ? payload.targetId.trim() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    const isKudos = payload.isKudos === true;
    const kudosEmoji =
      typeof payload.kudosEmoji === "string" && payload.kudosEmoji.length <= 16
        ? payload.kudosEmoji
        : null;

    if (!targetType) return NextResponse.json({ error: "targetType required" }, { status: 400 });
    if (!targetId) return NextResponse.json({ error: "targetId required" }, { status: 400 });
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });
    if (body.length > 2000) {
      return NextResponse.json({ error: "body too long (max 2000)" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const id = `rp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await supabase
      .from("update_replies")
      .insert({
        id,
        target_type: targetType,
        target_id: targetId,
        user_id: userId,
        body,
        is_kudos: isKudos,
        kudos_emoji: isKudos ? kudosEmoji : null
      })
      .select("id, body, is_kudos, kudos_emoji, created_at, edited_at, user_id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Hydrate the author so the client can append without a refetch.
    const { data: u } = await supabase
      .from("users")
      .select("id, name, avatar_url")
      .eq("id", userId)
      .maybeSingle();

    return NextResponse.json({
      reply: {
        id: data.id,
        userId: data.user_id,
        userName: u?.name ?? "—",
        avatarUrl: u?.avatar_url ?? null,
        body: data.body,
        isKudos: data.is_kudos,
        kudosEmoji: data.kudos_emoji,
        createdAt: data.created_at,
        editedAt: data.edited_at,
        mine: true
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
