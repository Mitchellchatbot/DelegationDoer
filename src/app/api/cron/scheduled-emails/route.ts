import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sendReply } from "@/lib/missive-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sends every scheduled email that's now due. Runs every minute via
// Vercel cron. Each row is dispatched independently — a failure on
// one doesn't block the rest, and the row's `error` column captures
// the reason for later inspection.
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const nowIso = new Date().toISOString();
    const { data: due, error } = await supabase
      .from("scheduled_emails")
      .select("id, thread_id, account_id, to_emails, cc_emails, subject, body_text, body_html, in_reply_to")
      .eq("status", "pending")
      .lte("scheduled_for", nowIso)
      // Cap per-tick so a backlog can't run away with the cron's time budget.
      .limit(50);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    let sent = 0, failed = 0;
    for (const row of due ?? []) {
      try {
        // Optimistically flip to 'sent' BEFORE the network call so a
        // duplicate cron tick can't double-dispatch the same row. If the
        // send fails we'll re-write the status to 'failed' below.
        const { error: claimErr } = await supabase
          .from("scheduled_emails")
          .update({ status: "sent", sent_at: nowIso })
          .eq("id", row.id)
          .eq("status", "pending");
        if (claimErr) {
          failed++;
          continue;
        }
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
        sent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("scheduled_emails")
          .update({ status: "failed", error: msg, sent_at: null })
          .eq("id", row.id);
        failed++;
      }
    }

    return NextResponse.json({ ok: true, considered: due?.length ?? 0, sent, failed });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
