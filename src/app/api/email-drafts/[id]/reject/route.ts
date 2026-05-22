import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canApproveDraft } from "@/lib/email-approvers";
import { lookupUserByEmail, openDm, postMessage } from "@/lib/slack";
import { recordDraftEvent } from "@/lib/draft-events";

export const dynamic = "force-dynamic";

// POST /api/email-drafts/[id]/reject
//   body: { note: string }
//   Flips the draft to 'rejected' + records the note. DMs the author
//   on Slack so they can fix and resubmit (the rejection note is the
//   whole point of the flow — silent rejects are useless).

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!note) {
      return NextResponse.json({ error: "rejection note required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: row, error: fetchErr } = await supabase
      .from("email_drafts")
      .select("id, author_id, kind, status, client_name, subject")
      .eq("id", params.id)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    const allowed = await canApproveDraft(
      { id: me.id, name: me.name, role: me.role, isAdmin: me.isAdmin, departmentIds: me.departmentIds },
      { author_id: row.author_id as string, kind: row.kind }
    );
    if (!allowed) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (row.status !== "pending") {
      return NextResponse.json({ error: `draft is ${row.status}, can't reject` }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("email_drafts")
      .update({
        status: "rejected",
        approver_id: userId,
        rejected_at: now,
        rejection_note: note.slice(0, 2000)
      })
      .eq("id", params.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    await recordDraftEvent({
      draftId: params.id,
      actorId: userId,
      type: "rejected",
      body: note.slice(0, 4000)
    });

    // DM the author so they actually see the rejection. Best-effort —
    // no point failing the reject if Slack is down.
    let slackDelivered = false;
    try {
      const { data: authorRow } = await supabase
        .from("users")
        .select("email")
        .eq("id", row.author_id)
        .maybeSingle();
      const email = authorRow?.email as string | null | undefined;
      if (email && process.env.SLACK_BOT_TOKEN) {
        const slackId = await lookupUserByEmail(email);
        const dm = await openDm(slackId);
        const text = `❌ Your email draft for *${row.client_name}* was rejected — see note.`;
        const blocks = [
          { type: "header", text: { type: "plain_text", text: "❌ Email draft rejected" } },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Client:*\n${row.client_name}` },
              { type: "mrkdwn", text: `*Subject:*\n${row.subject}` },
              { type: "mrkdwn", text: `*Rejected by:*\n${me.name ?? "an approver"}` }
            ]
          },
          { type: "section", text: { type: "mrkdwn", text: `*Note:*\n>${note.split("\n").join("\n>")}` } }
        ];
        await postMessage(dm, text, blocks);
        slackDelivered = true;
      }
    } catch { /* swallow — note is in DB */ }

    return NextResponse.json({ ok: true, rejectedAt: now, slackDelivered });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
