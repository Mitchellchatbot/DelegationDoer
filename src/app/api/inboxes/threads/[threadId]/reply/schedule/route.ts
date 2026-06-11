import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { deleteReplyDraft } from "@/lib/inbox-drafts";

export const dynamic = "force-dynamic";

// POST /api/inboxes/threads/[threadId]/reply/schedule
//   body: {
//     accountId, to, cc?, subject?, bodyText, bodyHtml?, inReplyTo?,
//     scheduledForISO   // when to send
//   }
//
// Stores the reply in `scheduled_emails` instead of sending now. The
// cron at /api/cron/scheduled-emails picks it up at scheduled_for and
// dispatches via the Missive clone.
//
// Access: same gate as the immediate reply route — the caller has to
// be able to see the account they're sending from.
export async function POST(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });

    // Inbox visibility gate.
    const visibleIds = await visibleAccountIdsFor(me);
    if (visibleIds !== null && !visibleIds.has(accountId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const toList: string[] = Array.isArray(body.to)
      ? body.to.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    if (toList.length === 0) {
      return NextResponse.json({ error: "to required" }, { status: 400 });
    }
    const ccList: string[] = Array.isArray(body.cc)
      ? body.cc.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const bodyText = typeof body.bodyText === "string" ? body.bodyText : "";
    if (!bodyText.trim()) {
      return NextResponse.json({ error: "bodyText required" }, { status: 400 });
    }

    const scheduledForIso = typeof body.scheduledForISO === "string" ? body.scheduledForISO : "";
    const scheduledFor = new Date(scheduledForIso);
    if (Number.isNaN(scheduledFor.getTime())) {
      return NextResponse.json({ error: "scheduledForISO must be a valid ISO datetime" }, { status: 400 });
    }
    if (scheduledFor.getTime() <= Date.now()) {
      return NextResponse.json({ error: "scheduledForISO must be in the future" }, { status: 400 });
    }

    const id = `se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await getSupabaseAdmin()
      .from("scheduled_emails")
      .insert({
        id,
        thread_id: params.threadId,
        account_id: accountId,
        user_id: userId,
        to_emails: toList,
        cc_emails: ccList,
        subject: typeof body.subject === "string" ? body.subject : null,
        body_text: bodyText,
        body_html: typeof body.bodyHtml === "string" ? body.bodyHtml : null,
        in_reply_to: typeof body.inReplyTo === "string" ? body.inReplyTo : null,
        scheduled_for: scheduledFor.toISOString(),
        status: "pending"
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Reply content now lives in scheduled_emails — clear the working draft so
    // it doesn't linger in the Drafts folder. Best-effort.
    await deleteReplyDraft(userId, params.threadId).catch(() => {});

    return NextResponse.json({ ok: true, scheduled: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
