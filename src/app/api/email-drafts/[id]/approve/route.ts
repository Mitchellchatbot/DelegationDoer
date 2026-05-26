import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canApproveDraft } from "@/lib/email-approvers";
import { composeNewThread } from "@/lib/missive-client";
import { recordDraftEvent } from "@/lib/draft-events";
import { sanitizeMediaUrls, fetchMediaAsAttachments } from "@/lib/media";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/email-drafts/[id]/approve
//   Marks the draft approved + fires the outbound send via missiveclone
//   using the author's connected mailbox. Re-running an approve on an
//   already-sent or already-approved draft is a no-op (idempotent),
//   which matters because the UI optimistically marks then refetches.
//
// Permissions: caller must be an approver of the draft's kind, OR a
// leader / admin (always).

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const { data: row, error: fetchErr } = await supabase
      .from("email_drafts")
      .select("*")
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

    // Idempotent — if it's already sent or already approved+sending,
    // return the current state instead of double-sending.
    if (row.status === "sent" || row.status === "approved") {
      return NextResponse.json({ ok: true, status: row.status, note: "already approved" });
    }
    if (row.status === "rejected") {
      return NextResponse.json({ error: "draft was rejected" }, { status: 400 });
    }

    // Sending-mailbox resolution chain:
    //   1. body.accountId — approver picked one explicitly on the UI
    //   2. row.account_id — already pinned at draft create time
    //   3. author's first connected inbox via inbox_assignments
    //   4. approver's first connected inbox (rescue path so a leader
    //      can still proof-and-send when the worker hasn't OAuth'd yet)
    //
    // Whichever wins is persisted back onto the row so a later retry
    // doesn't re-resolve.
    const body = await req.json().catch(() => ({} as { accountId?: string }));
    let accountId: string | null =
      (typeof body.accountId === "string" && body.accountId) ? body.accountId :
      (row.account_id as string | null);

    if (!accountId) {
      const { data: authorAssignment } = await supabase
        .from("inbox_assignments")
        .select("missive_account_id")
        .eq("user_id", row.author_id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      accountId = (authorAssignment?.missive_account_id as string | null) ?? null;
    }
    if (!accountId) {
      // Last-resort fallback: approver's own mailbox. Surfaces in the
      // outbound From: header so the client knows who sent it.
      const { data: approverAssignment } = await supabase
        .from("inbox_assignments")
        .select("missive_account_id")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      accountId = (approverAssignment?.missive_account_id as string | null) ?? null;
    }
    if (!accountId) {
      return NextResponse.json({
        error: "no connected mailbox to send from — neither the author nor you have one linked. Sign in via Connect inbox first."
      }, { status: 422 });
    }

    const now = new Date().toISOString();
    // Flip to 'approved' first so concurrent approve clicks short-circuit.
    const { error: lockErr } = await supabase
      .from("email_drafts")
      .update({ status: "approved", approver_id: userId, approved_at: now, account_id: accountId })
      .eq("id", params.id)
      .eq("status", "pending"); // only flip if still pending
    if (lockErr) return NextResponse.json({ error: lockErr.message }, { status: 500 });

    await recordDraftEvent({
      draftId: params.id,
      actorId: userId,
      type: "approved"
    });

    // Future-dated send: stop here. The scheduled-emails cron will pick
    // up this row (status='approved' + scheduled_for in the past) and
    // dispatch via composeNewThread when due.
    const scheduledFor = row.scheduled_for as string | null;
    if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()) {
      return NextResponse.json({
        ok: true,
        status: "approved",
        scheduledFor,
        note: "queued for scheduled send"
      });
    }

    // Fire the actual outbound send. On failure, flip status='failed'
    // + record send_error so the queue can show why and the approver
    // can retry by re-clicking (we re-allow approve on 'failed' below).
    const mediaItems = sanitizeMediaUrls(row.media_urls);
    const attachments = mediaItems.length > 0
      ? await fetchMediaAsAttachments(mediaItems)
      : undefined;
    try {
      const result = await composeNewThread({
        fromAccountId: accountId,
        to: row.to_emails as string[],
        cc: (row.cc_emails as string[]) ?? [],
        bcc: (row.bcc_emails as string[]) ?? [],
        subject: row.subject as string,
        bodyText: row.body_text as string,
        bodyHtml: (row.body_html as string | null) ?? undefined,
        attachments
      });
      const sentAt = new Date().toISOString();
      await supabase
        .from("email_drafts")
        .update({
          status: "sent",
          sent_at: sentAt,
          missive_thread_id: result.threadId ?? null,
          missive_message_id: result.messageId ?? null,
          send_error: null
        })
        .eq("id", params.id);
      await recordDraftEvent({
        draftId: params.id,
        actorId: userId,
        type: "sent",
        metadata: {
          missive_thread_id: result.threadId ?? null,
          missive_message_id: result.messageId ?? null
        }
      });
      return NextResponse.json({
        ok: true,
        status: "sent",
        sentAt,
        missiveThreadId: result.threadId,
        missiveMessageId: result.messageId
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "send failed";
      await supabase
        .from("email_drafts")
        .update({ status: "failed", send_error: msg })
        .eq("id", params.id);
      await recordDraftEvent({
        draftId: params.id,
        actorId: userId,
        type: "send_failed",
        body: msg
      });
      return NextResponse.json({ ok: false, status: "failed", error: msg }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
