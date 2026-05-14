import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// Workspace-wide Slack channel config (Scaled Team + EOD recap target).
// GET is open to any signed-in user so the UI can render the current
// state; PUT is Leader-only because flipping these channels affects
// every member.

export async function GET() {
  try {
    await requireCurrentUserId();
    const { data } = await getSupabaseAdmin()
      .from("workspace_settings")
      .select("scaled_team_channel_id, eod_recap_channel_id, last_eod_recap_at")
      .eq("id", "workspace")
      .maybeSingle();
    return NextResponse.json({
      scaledTeamChannelId: (data?.scaled_team_channel_id as string | null) ?? null,
      eodRecapChannelId: (data?.eod_recap_channel_id as string | null) ?? null,
      lastEodRecapAt: (data?.last_eod_recap_at as string | null) ?? null
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (me?.role !== "leader") {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const body = await req.json();
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.scaledTeamChannelId === null || typeof body.scaledTeamChannelId === "string") {
      update.scaled_team_channel_id = body.scaledTeamChannelId
        ? String(body.scaledTeamChannelId).trim() || null
        : null;
    }
    if (body.eodRecapChannelId === null || typeof body.eodRecapChannelId === "string") {
      update.eod_recap_channel_id = body.eodRecapChannelId
        ? String(body.eodRecapChannelId).trim() || null
        : null;
    }
    const { data, error } = await getSupabaseAdmin()
      .from("workspace_settings")
      .upsert({ id: "workspace", ...update }, { onConflict: "id" })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      scaledTeamChannelId: (data.scaled_team_channel_id as string | null) ?? null,
      eodRecapChannelId: (data.eod_recap_channel_id as string | null) ?? null
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
