import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/users/me — minimal profile for the current user. Used by
// the widget's settings view to render the picture editor without a
// full team-roster fetch.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    // Try fetching widget_icon_url first; fall back to the smaller
    // shape if the column hasn't been migrated yet.
    let row: Record<string, unknown> | null = null;
    {
      const { data, error } = await supabase
        .from("users")
        .select("id, name, email, avatar_url, role, is_admin, widget_icon_url, slack_user_id, slack_team_id, slack_connected_at, birthday, onboarded_at, slack_last_sync_at, slack_last_sync_ok, slack_last_sync_msg, google_user_id, google_email, google_connected_at, google_last_sync_at, google_last_sync_ok, google_last_sync_msg, clock_enabled, personal_email, phone, job_title, location, bio, pronouns, work_hours_start, work_hours_end, work_timezone, weekly_schedule")
        .eq("id", userId)
        .maybeSingle();
      if (!error && data) row = data;
    }
    if (!row) {
      const { data, error } = await supabase
        .from("users")
        .select("id, name, email, avatar_url, role")
        .eq("id", userId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
      row = data;
    }
    return NextResponse.json({
      user: {
        id: row.id as string,
        name: row.name as string,
        email: row.email as string,
        avatarUrl: (row.avatar_url as string | null) ?? null,
        role: row.role as string,
        isAdmin: (row.is_admin as boolean | null) === true,
        widgetIconUrl: (row.widget_icon_url as string | null) ?? null,
        slackUserId: (row.slack_user_id as string | null) ?? null,
        slackTeamId: (row.slack_team_id as string | null) ?? null,
        slackConnectedAt: (row.slack_connected_at as string | null) ?? null,
        birthday: (row.birthday as string | null) ?? null,
        onboardedAt: (row.onboarded_at as string | null) ?? null,
        slackLastSyncAt: (row.slack_last_sync_at as string | null) ?? null,
        slackLastSyncOk: (row.slack_last_sync_ok as boolean | null) ?? null,
        slackLastSyncMsg: (row.slack_last_sync_msg as string | null) ?? null,
        googleUserId: (row.google_user_id as string | null) ?? null,
        googleEmail: (row.google_email as string | null) ?? null,
        googleConnectedAt: (row.google_connected_at as string | null) ?? null,
        googleLastSyncAt: (row.google_last_sync_at as string | null) ?? null,
        googleLastSyncOk: (row.google_last_sync_ok as boolean | null) ?? null,
        googleLastSyncMsg: (row.google_last_sync_msg as string | null) ?? null,
        clockEnabled: (row.clock_enabled as boolean | null) ?? true,
        personalEmail: (row.personal_email as string | null) ?? null,
        phone: (row.phone as string | null) ?? null,
        jobTitle: (row.job_title as string | null) ?? null,
        location: (row.location as string | null) ?? null,
        bio: (row.bio as string | null) ?? null,
        pronouns: (row.pronouns as string | null) ?? null,
        workHoursStart: (row.work_hours_start as string | null) ?? null,
        workHoursEnd: (row.work_hours_end as string | null) ?? null,
        workTimezone: (row.work_timezone as string | null) ?? null,
        weeklySchedule: (row.weekly_schedule as Record<string, unknown> | null) ?? {}
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// PATCH /api/users/me — edit your own profile. Accepts name + the
// contact / bio fields. Work email stays read-only (it's the auth
// identity) — change `personalEmail` if you want a different
// reach-out address. Any null clears that field.
//
// Field caps prevent runaway sizes but stay generous enough for
// real values (240-char bio, 60-char job title etc.).
export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const update: Record<string, unknown> = {};

    function takeString(key: string, dbCol: string, maxLen: number) {
      const v = body[key];
      if (v === null) update[dbCol] = null;
      else if (typeof v === "string") {
        const t = v.trim().slice(0, maxLen);
        update[dbCol] = t || null;
      }
    }
    if (typeof body.name === "string" && body.name.trim()) {
      update.name = body.name.trim().slice(0, 80);
    }
    takeString("personalEmail", "personal_email", 120);
    takeString("phone",         "phone",          40);
    takeString("jobTitle",      "job_title",      60);
    takeString("location",      "location",       80);
    takeString("bio",           "bio",            500);
    takeString("pronouns",      "pronouns",       30);
    // Work hours: store HH:MM and the IANA timezone the user picked.
    // Server doesn't validate strict timezone names — Intl on the
    // client will silently fall back to UTC for typos, which is fine
    // for "shipping today" semantics.
    takeString("workHoursStart", "work_hours_start", 5);
    takeString("workHoursEnd",   "work_hours_end",   5);
    takeString("workTimezone",   "work_timezone",    60);

    // Per-day schedule. Accepts a small object keyed by mon/tue/.../sun;
    // each day is either null (day off) or { start, end } in HH:MM.
    // Validates structure so a malformed payload can't poison the row.
    if (body.weeklySchedule !== undefined) {
      const raw = body.weeklySchedule;
      if (raw === null) {
        update.weekly_schedule = {};
      } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const cleaned: Record<string, { start: string; end: string } | null> = {};
        const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
        const hhmm = /^[0-2]\d:[0-5]\d$/;
        for (const d of days) {
          const v = (raw as Record<string, unknown>)[d];
          if (v === null || v === undefined) {
            cleaned[d] = null;
            continue;
          }
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const start = (v as { start?: unknown }).start;
            const end = (v as { end?: unknown }).end;
            if (
              typeof start === "string" && hhmm.test(start) &&
              typeof end === "string" && hhmm.test(end)
            ) {
              cleaned[d] = { start, end };
            } else {
              cleaned[d] = null;
            }
          } else {
            cleaned[d] = null;
          }
        }
        update.weekly_schedule = cleaned;
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("users")
      .update(update)
      .eq("id", userId)
      .select("id, name, email, avatar_url, personal_email, phone, job_title, location, bio, pronouns")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ user: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
