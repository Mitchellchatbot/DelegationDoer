import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { teamMeta } from "@/lib/client-teams";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";

export const dynamic = "force-dynamic";

// POST /api/clients/[id]/note-alert   Body: { note: string }
//   DM the client's SEO team lead that a note was left on this client (the
//   "Save & notify lead" action on the client-split board). Leader/head/admin
//   only — the same gate as editing the client. Best-effort by design: the
//   note itself is already saved via PATCH; this only pings the lead.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !(me.role === "leader" || me.role === "department_head" || me.isAdmin)) {
      return NextResponse.json({ error: "leader/head/admin only" }, { status: 403 });
    }

    const { note } = await req.json().catch(() => ({}));
    const text = typeof note === "string" ? note.trim() : "";
    if (!text) return NextResponse.json({ error: "note required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const { data: client } = await supabase
      .from("clients")
      .select("id, name, team_id")
      .eq("id", params.id)
      .maybeSingle();
    if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });

    const leadEmail = teamMeta(client.team_id as string | null)?.leadEmail;
    if (!leadEmail) return NextResponse.json({ ok: true, skipped: "no-lead-for-team" });

    if (!process.env.SLACK_BOT_TOKEN) {
      return NextResponse.json({ error: "SLACK_BOT_TOKEN missing" }, { status: 500 });
    }

    const { data: leadRow } = await supabase
      .from("users")
      .select("id, name, email, slack_user_id, slack_email")
      .eq("email", leadEmail)
      .maybeSingle();

    let slackId: string;
    try {
      slackId = await resolveSlackId(
        leadRow
          ? { id: leadRow.id, email: leadRow.email, slack_user_id: leadRow.slack_user_id, slack_email: leadRow.slack_email }
          : { email: leadEmail }
      );
    } catch (e) {
      return NextResponse.json(
        { error: `couldn't resolve lead's Slack: ${e instanceof Error ? e.message : "unknown"}` },
        { status: 502 }
      );
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const url = `${baseUrl}/clients/${client.id}`;
    const fallback = `${me.name} left a note on ${client.name}: ${text}`;
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `📝 *${me.name}* left a note on *<${url}|${client.name}>*:` }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `>${text.replace(/\n/g, "\n>")}`.slice(0, 2990) }
      }
    ];

    const dm = await openDm(slackId);
    await postMessage(dm, fallback, blocks);
    return NextResponse.json({ ok: true, notified: leadRow?.name ?? leadEmail });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
