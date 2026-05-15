import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { broadcastNewRecommendation } from "@/lib/slack";

export const dynamic = "force-dynamic";

const VALID_KINDS = new Set(["movie", "tv", "album", "art", "game", "video", "custom"]);

function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// GET /api/recommendations
//   Returns every recommendation, newest first, with the author's
//   public profile joined in. Anyone authenticated can read.
export async function GET(_req: NextRequest) {
  try {
    await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("eom_recommendations")
      .select("id, user_id, month, kind, title, subtitle, body, external_id, external_url, image_url, audio_url, layout, created_at")
      .order("created_at", { ascending: false });
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) {
        return NextResponse.json({ recommendations: [], userById: {} });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const userIds = Array.from(new Set((data ?? []).map((r) => r.user_id as string)));
    let userById: Record<string, { id: string; name: string; avatarUrl: string | null }> = {};
    if (userIds.length > 0) {
      const { data: usersRows } = await supabase
        .from("users")
        .select("id, name, avatar_url")
        .in("id", userIds);
      for (const u of usersRows ?? []) {
        userById[u.id as string] = {
          id: u.id as string,
          name: u.name as string,
          avatarUrl: (u.avatar_url as string | null) ?? null
        };
      }
    }
    return NextResponse.json({
      recommendations: (data ?? []).map((r) => ({
        id: r.id,
        userId: r.user_id,
        month: r.month,
        kind: r.kind,
        title: r.title,
        subtitle: r.subtitle,
        body: r.body,
        externalId: r.external_id,
        externalUrl: r.external_url,
        imageUrl: r.image_url,
        audioUrl: r.audio_url,
        layout: r.layout,
        createdAt: r.created_at
      })),
      userById
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/recommendations
//   body: { kind, title, subtitle?, body?, externalId?, externalUrl?,
//           imageUrl?, audioUrl?, layout? }
//   Only the current month's Employee of the Month can create. Leader
//   bypass too so they can seed the feature.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const month = currentMonthKey();

    // Verify the actor is the current EoM (or leader).
    const [{ data: meRow }, { data: eomRow }] = await Promise.all([
      supabase.from("users").select("role, is_admin").eq("id", userId).maybeSingle(),
      supabase
        .from("employee_of_month")
        .select("user_id")
        .eq("month", month)
        .maybeSingle()
    ]);
    const isLeader = meRow?.role === "leader" || meRow?.is_admin === true;
    const isCurrentEom = eomRow?.user_id === userId;
    if (!isLeader && !isCurrentEom) {
      return NextResponse.json(
        { error: "Only this month's Employee of the Month can post." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!VALID_KINDS.has(kind)) {
      return NextResponse.json({ error: "invalid kind" }, { status: 400 });
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }
    const id = `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const row = {
      id,
      user_id: userId,
      month,
      kind,
      title: title.slice(0, 200),
      subtitle: typeof body.subtitle === "string" ? body.subtitle.trim().slice(0, 200) || null : null,
      body: typeof body.body === "string" ? body.body.trim().slice(0, 4000) || null : null,
      external_id: typeof body.externalId === "string" ? body.externalId : null,
      external_url: typeof body.externalUrl === "string" ? body.externalUrl : null,
      image_url: typeof body.imageUrl === "string" ? body.imageUrl : null,
      audio_url: typeof body.audioUrl === "string" ? body.audioUrl : null,
      layout: body.layout && typeof body.layout === "object" && !Array.isArray(body.layout)
        ? body.layout
        : {}
    };
    const { error } = await supabase.from("eom_recommendations").insert(row);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Fire-and-forget Slack broadcast — env-gated, never blocks.
    void (async () => {
      const [{ data: author }, { data: ws }] = await Promise.all([
        supabase.from("users").select("name, email").eq("id", userId).maybeSingle(),
        supabase.from("workspace_settings").select("scaled_team_channel_id").maybeSingle()
      ]);
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      await broadcastNewRecommendation({
        channel: (ws?.scaled_team_channel_id as string | null) ?? null,
        authorName: author?.name ?? "Someone",
        authorEmail: author?.email ?? null,
        kind: row.kind,
        title: row.title,
        subtitle: row.subtitle,
        body: row.body,
        imageUrl: row.image_url,
        externalUrl: row.external_url,
        recsUrl: `${baseUrl}/updates/recommendations`
      });
    })().catch(() => { /* swallow */ });

    return NextResponse.json({ recommendation: row });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE — only the author or a leader can take it down.
export async function DELETE(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [{ data: rec }, { data: meRow }] = await Promise.all([
      supabase.from("eom_recommendations").select("user_id").eq("id", id).maybeSingle(),
      supabase.from("users").select("role, is_admin").eq("id", userId).maybeSingle()
    ]);
    if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (rec.user_id !== userId && meRow?.role !== "leader" && meRow?.is_admin !== true) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const { error } = await supabase.from("eom_recommendations").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
