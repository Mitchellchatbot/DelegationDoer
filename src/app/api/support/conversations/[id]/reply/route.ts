import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupportUser } from "@/lib/support-auth";
import { getConversation } from "@/lib/support-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sendBlooioMessage } from "@/lib/blooio";
import { recordOutboundMessage } from "@/lib/support-intake";

export const dynamic = "force-dynamic";

// POST /api/support/conversations/[id]/reply   { text }
// Sends an outbound SMS to the contact via Blooio and persists it on the
// conversation thread. The chat id is the conversation's blooio_chat_id (the
// contact's E.164 phone).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getSupportUser();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => ({} as { text?: string }));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const conversation = await getConversation(id);
  if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const send = await sendBlooioMessage(conversation.blooioChatId, text);
  if (!send.ok) {
    return NextResponse.json({ error: send.error }, { status: 502 });
  }

  // Blooio may not echo a message_id; synthesize a unique local id so the
  // NOT NULL UNIQUE column is satisfied and the bubble persists immediately. The
  // randomUUID suffix prevents two same-millisecond null-id replies from
  // colliding (ON CONFLICT DO NOTHING would otherwise silently drop one bubble,
  // and the poller can't backfill it — it skips outbound messages).
  const messageId = send.messageId ?? `local:${conversation.id}:${Date.now()}:${randomUUID()}`;
  try {
    await recordOutboundMessage({
      chatId: conversation.blooioChatId,
      blooioMessageId: messageId,
      body: text,
      sentAt: new Date().toISOString()
    });
    // Replying to a resolved conversation re-opens it so it returns to the inbox.
    if (conversation.status === "closed") {
      await getSupabaseAdmin()
        .from("support_conversations")
        .update({ status: "open" })
        .eq("id", conversation.id);
    }
  } catch (err) {
    // The SMS already went out — log the persistence failure but report success.
    console.error("[support-reply] failed to persist outbound message", {
      conversationId: id,
      error: err instanceof Error ? err.message : err
    });
  }

  return NextResponse.json({ ok: true, messageId, status: send.status });
}
