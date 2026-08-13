import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getBlooioMessage, isBlooioInboundEnabled } from "@/lib/blooio";
import { ingestInboundMessage } from "@/lib/support-intake";

export const dynamic = "force-dynamic";

// POST /api/integrations/blooio/webhook
//
// Real-time inbound SMS capture for the customer-support inbox. Blooio fires a
// webhook per event; we verify the signature, and for `message.received` we
// fetch the AUTHORITATIVE message by id and hand it to lib/support-intake.ts
// (classify + route). The polling cron (lib/support-inbox-poller.ts) is the
// backstop — both are idempotent via support_messages.blooio_message_id, so a
// webhook and a poll can race without double-processing.
//
// Delivery body (Blooio docs):
//   { "event": "message.received", "message_id": "msg_...", "chat_id": "+1555...", "data": {...} }
// We read event / chat_id / message_id from the TOP LEVEL and never depend on
// the shape of `data` — the message content is fetched via
// GET /chats/{chatId}/messages/{messageId}.
//
// Signature: X-Blooio-Signature: t=<unix_ts>,v1=<hex> where
//   v1 = HMAC-SHA256(signing_secret, `${t}.${rawBody}`), hex digest.
// It is verified against the RAW body BEFORE JSON.parse — parsing first would
// change the bytes and break the HMAC (the docs' #1 footgun). Same construction
// as the Calendly webhook (src/app/api/integrations/calendly/webhook/route.ts);
// only the header name differs. The signing_secret is returned ONCE at webhook
// creation and must be stored in BLOOIO_WEBHOOK_SECRET.

const SECRET = process.env.BLOOIO_WEBHOOK_SECRET || "";
const REPLAY_WINDOW_SEC = 5 * 60;

function verify(rawBody: string, headerVal: string | null): boolean {
  if (!SECRET || !headerVal) return false;
  // Parse "t=...,v1=..." into a map.
  const parts = headerVal.split(",").reduce<Record<string, string>>((acc, p) => {
    const eq = p.indexOf("=");
    if (eq > 0) acc[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    return acc;
  }, {});
  const t = parts.t;
  const sig = parts.v1;
  if (!t || !sig) return false;
  // Replay protection — reject signatures outside the window.
  const tsSec = parseInt(t, 10);
  if (!Number.isFinite(tsSec)) return false;
  if (Math.abs(Date.now() / 1000 - tsSec) > REPLAY_WINDOW_SEC) return false;
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

interface BlooioWebhookEvent {
  event: string;
  chatId: string;
  messageId: string;
}

// The delivery carries event / chat_id / message_id at the top level.
function parseEvent(payload: Record<string, unknown>): BlooioWebhookEvent | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const event = str(payload.event);
  const chatId = str(payload.chat_id);
  const messageId = str(payload.message_id);
  if (!event || !chatId || !messageId) return null;
  return { event, chatId, messageId };
}

export async function POST(req: NextRequest) {
  // Inbound capture is off (see isBlooioInboundEnabled) — the Blooio org is
  // shared with the New Life CRM, so every delivery here is as likely to be
  // theirs as ours. Ack and drop before reading the body or verifying the
  // signature: 200 rather than 401/404 so Blooio neither retries nor marks the
  // endpoint failing, and no HMAC means no 401 log noise if the secret is unset.
  // The registration should also be deleted Blooio-side; this is the guard that
  // holds if it's ever re-added.
  if (!isBlooioInboundEnabled()) {
    return NextResponse.json({ ok: true, skipped: "inbound-disabled" });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("x-blooio-signature");
  if (!verify(rawBody, sig)) {
    console.error("[blooio-webhook] signature verification failed", {
      secretConfigured: !!SECRET,
      sigPresent: !!sig,
      bodyBytes: rawBody.length,
      // Header shape (not the message body) so a first-delivery mismatch —
      // stale secret, clock skew, format drift — is diagnosable.
      sigHead: sig ? sig.slice(0, 24) : null,
      bodyHead: rawBody.slice(0, 200)
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const evt = parseEvent(payload);
  if (!evt) {
    console.warn("[blooio-webhook] unparseable payload — missing event/chat_id/message_id", {
      bodyHead: rawBody.slice(0, 300)
    });
    // 200 so Blooio doesn't retry an event we structurally can't use.
    return NextResponse.json({ ok: true, skipped: "unparseable" });
  }

  // Only inbound messages create/append conversations. Every other event type
  // (message.sent/delivered/read/failed, reactions, status, polls, groups,
  // contacts, ...) is acknowledged and ignored.
  if (evt.event !== "message.received") {
    return NextResponse.json({ ok: true, skipped: evt.event });
  }

  // Fire-and-forget: fetching the message + classifying runs an LLM call
  // (~1-2s); blocking the ACK risks a Blooio retry storm. The poller backstops
  // anything this drops (idempotent on blooio_message_id). Always 200.
  void handleInbound(evt).catch((err) => {
    console.error("[blooio-webhook] ingest failed", {
      chatId: evt.chatId,
      messageId: evt.messageId,
      error: err instanceof Error ? err.message : err
    });
  });

  return NextResponse.json({ ok: true });
}

// Fetch the authoritative message by id (never trusting the webhook's `data`)
// and ingest it. If it isn't fetchable yet (propagation lag) the poller picks
// it up within ~60s — deduped by blooio_message_id.
async function handleInbound(evt: BlooioWebhookEvent): Promise<void> {
  const msg = await getBlooioMessage(evt.chatId, evt.messageId);
  if (!msg) {
    console.warn("[blooio-webhook] message not fetchable yet — deferring to poller", {
      chatId: evt.chatId,
      messageId: evt.messageId
    });
    return;
  }
  // message.received should always be inbound; guard defensively.
  if (msg.direction !== "inbound") return;
  await ingestInboundMessage({
    chatId: evt.chatId,
    phone: msg.externalId ?? evt.chatId,
    contactName: null, // the messages endpoint carries no contact name; the poller backfills it
    blooioMessageId: msg.id,
    body: msg.text,
    sentAt: msg.createdAt || new Date().toISOString(),
    direction: "inbound"
  });
}
