import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/eod/client-checkins
//   body: { date?: 'YYYY-MM-DD', clientId: string|null, clientName: string, message: string }
//   Creates one end-of-day client status row + best-effort posts it to
//   Slack (the workspace's scaled_team_channel_id) with a 📊 prefix so
//   the team can tell EOD check-ins apart from ad-hoc touch logs.
//
// GET /api/eod/client-checkins?date=YYYY-MM-DD&userId=...
//   Returns the caller's check-ins for that date by default + a count
//   of check-ins filed in the past 7 days (powers the dashboard + the
//   widget's "have I filed today?" nudge).

interface CheckinRow {
  id: string;
  user_id: string;
  note_date: string;
  client_id: string | null;
  client_name: string;
  subject: string | null;
  message: string;
  slack_ts: string | null;
  slack_channel: string | null;
  sent_at: string | null;
  created_at: string;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const body = await req.json().catch(() => ({}));
    const dateStr =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date().toISOString().slice(0, 10);
    const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 300) : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!clientName) {
      return NextResponse.json({ error: "clientName required" }, { status: 400 });
    }
    if (!subject) {
      return NextResponse.json({ error: "subject required" }, { status: 400 });
    }
    if (!message) {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }
    if (message.length > 4000) {
      return NextResponse.json({ error: "message too long (max 4000 chars)" }, { status: 400 });
    }

    const [{ data: author }, { data: ws }] = await Promise.all([
      supabase.from("users").select("name").eq("id", userId).maybeSingle(),
      supabase.from("workspace_settings").select("scaled_team_channel_id").eq("id", "workspace").maybeSingle()
    ]);
    const authorName = (author?.name as string | undefined) ?? "Someone";
    const channel = (ws?.scaled_team_channel_id as string | null) ?? null;

    const id = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { error: insertErr } = await supabase.from("eod_client_checkins").insert({
      id,
      user_id: userId,
      note_date: dateStr,
      client_id: clientId,
      client_name: clientName.slice(0, 200),
      subject,
      message: message.slice(0, 4000)
    });
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    let slackTs: string | null = null;
    let slackChannel: string | null = null;
    let slackError: string | null = null;
    if (channel && process.env.SLACK_BOT_TOKEN) {
      try {
        const text = `✉️ *${authorName}* → *${clientName}* — ${subject}`;
        const blocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✉️ *${authorName}* → *${clientName}*\n*Subject:* ${subject}\n>${message
                .slice(0, 2900)
                .replace(/\n/g, "\n>")}`
            }
          }
        ];
        const res = await postMessage(channel, text, blocks);
        slackTs = res.ts;
        slackChannel = channel;
        await supabase
          .from("eod_client_checkins")
          .update({ slack_ts: slackTs, slack_channel: slackChannel, sent_at: new Date().toISOString() })
          .eq("id", id);
      } catch (err) {
        slackError = err instanceof Error ? err.message : "slack post failed";
      }
    } else if (!channel) {
      slackError = "no scaled-team channel configured";
    } else {
      slackError = "SLACK_BOT_TOKEN missing";
    }

    return NextResponse.json({
      ok: true,
      checkin: {
        id,
        clientId,
        clientName,
        subject,
        message,
        slackTs,
        slackChannel,
        sentAt: slackTs ? new Date().toISOString() : null
      },
      slackError
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const sp = req.nextUrl.searchParams;
    const dateStr =
      sp.get("date") && /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") as string)
        ? (sp.get("date") as string)
        : new Date().toISOString().slice(0, 10);
    const targetUserId = sp.get("userId") || userId;

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoIso = weekAgo.toISOString();

    const [todayRes, weekRes] = await Promise.all([
      supabase
        .from("eod_client_checkins")
        .select("id, user_id, note_date, client_id, client_name, subject, message, slack_ts, slack_channel, sent_at, created_at")
        .eq("user_id", targetUserId)
        .eq("note_date", dateStr)
        .order("created_at", { ascending: true }),
      supabase
        .from("eod_client_checkins")
        .select("id", { count: "exact", head: true })
        .eq("user_id", targetUserId)
        .gte("sent_at", weekAgoIso)
    ]);
    if (todayRes.error) {
      return NextResponse.json({ error: todayRes.error.message }, { status: 500 });
    }

    return NextResponse.json({
      checkins: ((todayRes.data ?? []) as CheckinRow[]).map((r) => ({
        id: r.id,
        clientId: r.client_id,
        clientName: r.client_name,
        subject: r.subject,
        message: r.message,
        slackTs: r.slack_ts,
        slackChannel: r.slack_channel,
        sentAt: r.sent_at,
        createdAt: r.created_at
      })),
      weekCount: weekRes.count ?? 0
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
