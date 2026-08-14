import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

// Translate the raw Slack error code (slackCall throws
// `slack:chat.postMessage → <code>`) into something a leader reading a
// toast can act on. The common case by far is a private channel the bot
// was never invited to.
function explain(raw: string): string {
  const code = raw.split("→").pop()?.trim() ?? raw;
  if (raw.includes("SLACK_BOT_TOKEN missing")) {
    return "SLACK_BOT_TOKEN isn't set on this deployment — the app can't post anywhere.";
  }
  switch (code) {
    case "not_in_channel":
      return "The Delegation Doer app isn't in that channel — invite it with /invite @Delegation Doer.";
    case "channel_not_found":
      return "No channel with that ID, or it's private and the app hasn't been invited yet.";
    case "is_archived":
      return "That channel is archived.";
    case "missing_scope":
    case "not_allowed_token_type":
      return "The Slack app is missing a scope — reinstall it with chat:write.";
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return "The Slack bot token is invalid or revoked — reinstall the app.";
    default:
      return `Slack rejected it: ${code}`;
  }
}

// POST /api/slack/channel-test — { channelId: string }.
// Leader-only. Posts a throwaway message so a mistyped channel ID or a
// missing bot invite shows up here instead of silently swallowing every
// notification routed to that channel. Takes a channel ID rather than a
// department so the workspace-level channel fields can reuse it.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !(me.role === "leader" || me.isAdmin)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = await req.json();
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    if (!channelId) {
      return NextResponse.json({ error: "channelId required" }, { status: 400 });
    }

    // 200 with ok:false on a Slack-side rejection — that's a normal
    // outcome of a test, not a server fault, and the UI wants the text.
    try {
      await postMessage(
        channelId,
        `:white_check_mark: Delegation Doer can post here — test from Settings by ${me.name}.`
      );
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: explain(raw) });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
