import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { publish, type InboxEvent } from "@/lib/inbox-event-bus";
import { isDuplicateMessage } from "@/lib/missive-socket";
import { fanOutInboxEvent } from "@/lib/email-notifications";

export const dynamic = "force-dynamic";

// POST /api/missive-webhook
//   Fired by missiveclone after every successful inbound ingestMessage.
//   Body shape (set by missiveclone/backend/src/email/imap.js):
//     { event, ts, workspace_id, account_id, thread_id, message_id }
//   Signed with HMAC-SHA256(body, MISSIVE_WEBHOOK_SECRET) and sent as
//   the X-Missive-Signature header. We verify, then publish to the
//   in-process bus so subscribers (badge cache, SSE stream) react in
//   real time.

const SECRET = process.env.MISSIVE_WEBHOOK_SECRET || "";

// Constant-time signature comparison. timingSafeEqual throws on length
// mismatch, so we normalize to a fixed-size hex buffer first.
function verify(rawBody: string, sig: string | null): boolean {
  if (!SECRET || !sig) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-missive-signature");
  if (!verify(rawBody, sig)) {
    // Don't reveal whether the secret is unset vs the sig is wrong — same 401.
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let payload: Partial<InboxEvent>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!payload.event || !payload.account_id || !payload.thread_id) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  // Dedup against the socket bridge. When both paths deliver the same
  // message_id within 30s, suppress the second one so the bus doesn't
  // republish (which would cause every SSE subscriber to do a
  // redundant refetch). Either path winning is fine; whichever lands
  // first wins. We still ACK 200 — from missiveclone's perspective the
  // webhook succeeded.
  if (isDuplicateMessage(payload.message_id)) {
    return NextResponse.json({ ok: true, deduped: true });
  }
  const event: InboxEvent = {
    event: payload.event,
    workspace_id: payload.workspace_id,
    account_id: payload.account_id,
    thread_id: payload.thread_id,
    message_id: payload.message_id,
    ts: payload.ts ?? Date.now()
  };
  publish(event);
  // Fan out into email_notifications for users opted-in to this
  // account. Fire-and-forget so we ACK the webhook within ~5ms even if
  // the enrichment fetch is slow; any failure is logged inside.
  void fanOutInboxEvent(event).catch((err) => {
    console.error("[missive-webhook] fanOut", err);
  });
  return NextResponse.json({ ok: true });
}
