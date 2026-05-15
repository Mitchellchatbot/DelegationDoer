import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { broadcastNewMoment } from "@/lib/slack";

export const dynamic = "force-dynamic";

// GET /api/moments — newest 100 moments, with author info joined in.
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("moments")
    .select("id, user_id, image_url, caption, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const userIds = Array.from(new Set((data ?? []).map((r) => r.user_id as string)));
  const { data: users } = userIds.length > 0
    ? await supabase
        .from("users")
        .select("id, name, avatar_url")
        .in("id", userIds)
    : { data: [] };
  const userById = new Map(
    ((users ?? []) as { id: string; name: string; avatar_url: string | null }[])
      .map((u) => [u.id, u])
  );

  return NextResponse.json({
    moments: (data ?? []).map((r) => {
      const u = userById.get(r.user_id as string);
      return {
        id: r.id,
        userId: r.user_id,
        userName: u?.name ?? "Someone",
        userAvatarUrl: u?.avatar_url ?? null,
        imageUrl: r.image_url,
        caption: r.caption,
        createdAt: r.created_at
      };
    })
  });
}

// POST /api/moments — body: { imageUrl: string, caption?: string }
// Upload the image via /api/upload first (multipart), then call this
// with the resulting URL. Saves a row owned by the caller.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, 240) : null;
    if (!imageUrl) {
      return NextResponse.json({ error: "imageUrl required" }, { status: 400 });
    }
    const id = `mm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("moments").insert({
      id, user_id: userId, image_url: imageUrl, caption
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Fire-and-forget Slack broadcast so a missing token never blocks
    // the create. Env-gated on SLACK_MOMENTS_CHANNEL / SLACK_COMPANY_CHANNEL.
    void (async () => {
      const [{ data: author }, { data: ws }] = await Promise.all([
        supabase.from("users").select("name, email").eq("id", userId).maybeSingle(),
        supabase.from("workspace_settings").select("scaled_team_channel_id").maybeSingle()
      ]);
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      await broadcastNewMoment({
        channel: (ws?.scaled_team_channel_id as string | null) ?? null,
        authorName: author?.name ?? "Someone",
        authorEmail: author?.email ?? null,
        imageUrl,
        caption,
        momentsUrl: `${baseUrl}/moments`
      });
    })().catch(() => { /* swallow — broadcast is best-effort */ });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
