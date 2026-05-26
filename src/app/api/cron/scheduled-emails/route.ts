import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sendReply, composeNewThread } from "@/lib/missive-client";
import { sanitizeMediaUrls, fetchMediaAsAttachments } from "@/lib/media";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sends every scheduled email that's now due. Runs every minute via
// Vercel cron. Two queues are handled in one tick:
//   1. scheduled_emails — replies inside an existing Missive thread,
//      dispatched via sendReply.
//   2. email_drafts where status='approved' AND scheduled_for ≤ now —
//      future-dated drafts that have already cleared approval. These
//      are NEW outbound threads, dispatched via composeNewThread.
// Each row is independently claimed (status flipped before the network
// call) so a duplicate tick can't double-dispatch the same row.
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const nowIso = new Date().toISOString();

    // === 1. Scheduled replies ===
    const { data: dueReplies, error: replyErr } = await supabase
      .from("scheduled_emails")
      .select("id, thread_id, account_id, to_emails, cc_emails, subject, body_text, body_html, in_reply_to")
      .eq("status", "pending")
      .lte("scheduled_for", nowIso)
      .limit(50);
    if (replyErr) return NextResponse.json({ ok: false, error: replyErr.message }, { status: 500 });

    let sentReplies = 0, failedReplies = 0;
    for (const row of dueReplies ?? []) {
      try {
        const { error: claimErr } = await supabase
          .from("scheduled_emails")
          .update({ status: "sent", sent_at: nowIso })
          .eq("id", row.id)
          .eq("status", "pending");
        if (claimErr) { failedReplies++; continue; }
        await sendReply({
          threadId: row.thread_id as string,
          fromAccountId: row.account_id as string,
          to: (row.to_emails as string[]) ?? [],
          cc: (row.cc_emails as string[] | null) ?? [],
          subject: (row.subject as string | null) ?? undefined,
          bodyText: row.body_text as string,
          bodyHtml: (row.body_html as string | null) ?? undefined,
          inReplyTo: (row.in_reply_to as string | null) ?? undefined
        });
        sentReplies++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("scheduled_emails")
          .update({ status: "failed", error: msg, sent_at: null })
          .eq("id", row.id);
        failedReplies++;
      }
    }

    // === 2. Approved drafts whose scheduled_for is now due ===
    // Limited to drafts not yet sent (missive_thread_id IS NULL guards
    // against double-dispatch even if claim race ever happens).
    const { data: dueDrafts, error: draftErr } = await supabase
      .from("email_drafts")
      .select("id, account_id, to_emails, cc_emails, bcc_emails, subject, body_text, body_html, media_urls")
      .eq("status", "approved")
      .lte("scheduled_for", nowIso)
      .is("missive_thread_id", null)
      .limit(50);
    if (draftErr) {
      return NextResponse.json({ ok: false, error: draftErr.message }, { status: 500 });
    }

    let sentDrafts = 0, failedDrafts = 0;
    for (const row of dueDrafts ?? []) {
      const accountId = row.account_id as string | null;
      if (!accountId) {
        await supabase
          .from("email_drafts")
          .update({ status: "failed", send_error: "no account_id set at send-time" })
          .eq("id", row.id);
        failedDrafts++;
        continue;
      }
      try {
        // Optimistically flip to 'sent' BEFORE the network call so a
        // duplicate tick can't double-dispatch. We rewrite to 'failed'
        // on error below.
        const { error: claimErr } = await supabase
          .from("email_drafts")
          .update({ status: "sent", sent_at: nowIso })
          .eq("id", row.id)
          .eq("status", "approved");
        if (claimErr) { failedDrafts++; continue; }

        // The draft was scheduled, but the actual send is happening NOW
        // (sendAtMs is omitted), so the clone treats this as an immediate
        // send and accepts attachments.
        const mediaItems = sanitizeMediaUrls(row.media_urls);
        const attachments = mediaItems.length > 0
          ? await fetchMediaAsAttachments(mediaItems)
          : undefined;
        const result = await composeNewThread({
          fromAccountId: accountId,
          to: (row.to_emails as string[]) ?? [],
          cc: (row.cc_emails as string[] | null) ?? [],
          bcc: (row.bcc_emails as string[] | null) ?? [],
          subject: row.subject as string,
          bodyText: row.body_text as string,
          bodyHtml: (row.body_html as string | null) ?? undefined,
          attachments
        });
        await supabase
          .from("email_drafts")
          .update({
            missive_thread_id: result.threadId ?? null,
            missive_message_id: result.messageId ?? null,
            send_error: null
          })
          .eq("id", row.id);
        sentDrafts++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("email_drafts")
          .update({ status: "failed", send_error: msg, sent_at: null })
          .eq("id", row.id);
        failedDrafts++;
      }
    }

    return NextResponse.json({
      ok: true,
      replies: { considered: dueReplies?.length ?? 0, sent: sentReplies, failed: failedReplies },
      drafts: { considered: dueDrafts?.length ?? 0, sent: sentDrafts, failed: failedDrafts }
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
