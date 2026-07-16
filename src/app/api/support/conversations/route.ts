import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupportUser } from "@/lib/support-auth";
import { listConversations, type ConversationBucket } from "@/lib/support-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { normalizeE164 } from "@/lib/phone";
import { getBlooioSendingLine, sendBlooioMessage } from "@/lib/blooio";
import { ensureOperatorConversation, recordOutboundMessage } from "@/lib/support-intake";
import type { SupportConversation } from "@/lib/support-data";

export const dynamic = "force-dynamic";

// GET /api/support/conversations?bucket=support|review
//   - support : the customer_support inbox (open conversations).
//   - review  : the Needs Review queue (uncertain classifications).
export async function GET(req: NextRequest) {
  const me = await getSupportUser();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const raw = (req.nextUrl.searchParams.get("bucket") ?? "support").toLowerCase();
  const bucket: ConversationBucket = raw === "review" ? "review" : "support";

  try {
    const conversations = await listConversations(bucket);
    return NextResponse.json({ conversations });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to load conversations" },
      { status: 500 }
    );
  }
}

// POST /api/support/conversations   { phone, contactName?, text }
// Starts a conversation with a number that hasn't texted us. Blooio has no
// chat-creation call and no "from" param — the send itself mints the chat (the
// outbound drip already relies on this) — so composing is just a send plus the
// conversation row that inbound capture would normally have created.
//
// A number that already has a conversation APPENDS to it: blooio_chat_id is
// UNIQUE and Blooio would thread the texts regardless, so a second conversation
// for one number isn't representable. Never 409s.
export async function POST(req: NextRequest) {
  const me = await getSupportUser();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const rawPhone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const phone = rawPhone ? normalizeE164(rawPhone) : null;
  if (!phone) {
    return NextResponse.json({ error: "a valid phone number is required" }, { status: 400 });
  }
  // Texting our own line would loop our messages back into the inbox as a
  // conversation with ourselves.
  if (phone === getBlooioSendingLine()) {
    return NextResponse.json({ error: "that's our own sending line" }, { status: 400 });
  }
  const contactName =
    typeof body?.contactName === "string" && body.contactName.trim()
      ? body.contactName.trim()
      : null;

  // 1. Send BEFORE writing anything. A mistyped number is the likeliest failure
  //    of a hand-entered-phone feature, and Blooio rejecting it must not leave a
  //    ghost conversation (open, zero messages) sitting in the inbox forever.
  //    Nothing is persisted yet, so a 502 here leaves no trace.
  const send = await sendBlooioMessage(phone, text);
  if (!send.ok) return NextResponse.json({ error: send.error }, { status: 502 });

  // 2. The text is gone; from here we mirror the reply route's contract — log
  //    persistence failures but never fail the request, because reporting an
  //    error for a message the customer already received is the bigger lie.
  const messageId = send.messageId ?? `local:${phone}:${Date.now()}:${randomUUID()}`;
  // Hoisted so the catch can still hand back a conversation that was created
  // before a later step failed — the thread is real and openable even if the
  // message row didn't land, and claiming otherwise sends the operator looking
  // for something that's sitting right there.
  let ensured: { conversation: SupportConversation; isNew: boolean } | null = null;
  try {
    // Pre-creates the row so recordOutboundMessage's outbound guard finds it.
    ensured = await ensureOperatorConversation({
      phone,
      contactName,
      createdBy: me.id
    });
    const { conversation, isNew } = ensured;
    await recordOutboundMessage({
      chatId: phone,
      blooioMessageId: messageId,
      body: text,
      sentAt: new Date().toISOString()
    });
    // Composing into a resolved thread re-opens it, exactly as replying does.
    // Reported back as its own flag: the returned conversation is normalized to
    // the post-send state, so status alone can no longer tell the client that
    // this thread *was* closed — and that's what it needs to say so.
    const reopened = !isNew && conversation.status === "closed";
    if (reopened) {
      await getSupabaseAdmin()
        .from("support_conversations")
        .update({ status: "open" })
        .eq("id", conversation.id);
    }
    return NextResponse.json({
      ok: true,
      conversationId: conversation.id,
      // The pre-send snapshot with status reconciled — the client refetches the
      // list and thread immediately, so this only feeds the confirmation toast.
      conversation: { ...conversation, status: "open" },
      isNew,
      reopened,
      messageId,
      status: send.status
    });
  } catch (err) {
    console.error("[support-compose] failed to persist composed message", {
      phone,
      error: err instanceof Error ? err.message : err
    });
    // The text is already delivered, so this is never an error response — but it
    // isn't a clean success either, and `degraded` is what says so. The poller
    // can't backfill an outbound message (it skips them), so the bubble may stay
    // missing until the customer replies. Hand back the conversation if we got
    // one: the thread exists and should still open.
    return NextResponse.json({
      ok: true,
      degraded: true,
      conversationId: ensured?.conversation.id ?? null,
      // Unpatched, unlike the success path: the reopen runs after the step that
      // just threw, so this row may genuinely still be closed. Report what we
      // actually know rather than a status we never wrote.
      conversation: ensured?.conversation ?? null,
      isNew: ensured?.isNew ?? false,
      reopened: false,
      messageId
    });
  }
}
