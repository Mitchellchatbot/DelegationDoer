import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getMissiveSocketStatus } from "@/lib/missive-socket";
import { getClientEmailSlackState } from "@/lib/client-email-slack-bootstrap";
import { pollClientEmailSlack } from "@/lib/client-email-slack";

export const dynamic = "force-dynamic";

// GET /api/debug/client-email-slack
//   Diagnoses the #email-notifs pipeline: is the bootstrap running, is the
//   channel configured, is the socket bridge alive, and what has actually
//   been posted.
//
// GET /api/debug/client-email-slack?dryRun=1
//   Runs a full poll pass with posting DISABLED and returns the rendered
//   Slack payload for every client email it would have posted. This is the
//   only safe way to verify the wiring: booting DD locally against the prod
//   env fires every in-process scheduler against production, so "just start
//   the server and watch" is not an option here.
//
// Auth: leader/admin. Unlike the per-user email-notifications debug route,
// this exposes subjects and body previews across every inbox in the
// workspace, so it can't be open to any signed-in user.

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!(me?.role === "leader" || me?.isAdmin)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const supabase = getSupabaseAdmin();
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

    const { data: settings } = await supabase
      .from("workspace_settings")
      .select("client_email_channel_id")
      .eq("id", "workspace")
      .maybeSingle();

    const { data: recent } = await supabase
      .from("slack_client_email_posts")
      .select("message_id, thread_id, account_id, client_name, from_email, subject, slack_ts, posted_at")
      .order("posted_at", { ascending: false })
      .limit(20);

    const body: Record<string, unknown> = {
      channelId: (settings as { client_email_channel_id: string | null } | null)?.client_email_channel_id ?? null,
      slackTokenConfigured: !!process.env.SLACK_BOT_TOKEN,
      appUrlConfigured: !!process.env.NEXT_PUBLIC_APP_URL,
      // null here means the bootstrap never ran — check that
      // instrumentation.ts fired and this build actually deployed.
      bootstrap: getClientEmailSlackState(),
      socket: getMissiveSocketStatus(),
      recentPosts: recent ?? []
    };

    if (dryRun) {
      body.dryRun = await pollClientEmailSlack({ dryRun: true });
    }

    return NextResponse.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
