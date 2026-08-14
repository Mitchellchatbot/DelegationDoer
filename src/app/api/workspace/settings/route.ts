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
    // `*` rather than an explicit column list, on purpose: this route
    // discards the error and falls back to defaults, so naming a column that
    // doesn't exist yet fails the WHOLE query and the card would render the
    // already-configured Scaled Team / EOD channels as blank during any
    // window where code is deployed ahead of its migration. With `*` a
    // not-yet-migrated column is simply absent.
    const { data } = await getSupabaseAdmin()
      .from("workspace_settings")
      .select("*")
      .eq("id", "workspace")
      .maybeSingle();
    return NextResponse.json({
      scaledTeamChannelId: (data?.scaled_team_channel_id as string | null) ?? null,
      eodRecapChannelId: (data?.eod_recap_channel_id as string | null) ?? null,
      clientEmailChannelId: (data?.client_email_channel_id as string | null) ?? null,
      lastEodRecapAt: (data?.last_eod_recap_at as string | null) ?? null,
      lowSiteScoreThreshold: (data?.low_site_score_threshold as number | null) ?? 70,
      overdueArchiveDays: (data?.overdue_archive_days as number | null) ?? 10
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
    if (!(me?.role === "leader" || me?.isAdmin)) {
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
    // Channel that gets a ping whenever a known client emails one of our
    // inboxes (#email-notifs). Clearing it turns the notifier off.
    if (body.clientEmailChannelId === null || typeof body.clientEmailChannelId === "string") {
      update.client_email_channel_id = body.clientEmailChannelId
        ? String(body.clientEmailChannelId).trim() || null
        : null;
    }
    // Site-health alert threshold (0–100). Below this score a Website-team
    // task is auto-created from the Scaled Team channel alert.
    if (body.lowSiteScoreThreshold !== undefined && body.lowSiteScoreThreshold !== null) {
      const n = Math.round(Number(body.lowSiteScoreThreshold));
      if (Number.isFinite(n)) {
        update.low_site_score_threshold = Math.max(0, Math.min(100, n));
      }
    }
    // Overdue auto-archive threshold (days). An open task more than this many
    // days past its due date auto-archives off the active board. Clamp to a
    // sane floor of 1 day; cap at a year so a fat-finger can't disable it.
    if (body.overdueArchiveDays !== undefined && body.overdueArchiveDays !== null) {
      const n = Math.round(Number(body.overdueArchiveDays));
      if (Number.isFinite(n)) {
        update.overdue_archive_days = Math.max(1, Math.min(365, n));
      }
    }
    const { data, error } = await getSupabaseAdmin()
      .from("workspace_settings")
      .upsert({ id: "workspace", ...update }, { onConflict: "id" })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      scaledTeamChannelId: (data.scaled_team_channel_id as string | null) ?? null,
      eodRecapChannelId: (data.eod_recap_channel_id as string | null) ?? null,
      clientEmailChannelId: (data.client_email_channel_id as string | null) ?? null,
      lowSiteScoreThreshold: (data.low_site_score_threshold as number | null) ?? 70,
      overdueArchiveDays: (data.overdue_archive_days as number | null) ?? 10
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
