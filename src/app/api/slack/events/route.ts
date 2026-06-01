import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { routeChannelAlert } from "@/lib/site-alert-routing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // crypto needs Node runtime, not Edge

// Slack will POST events here. Three things happen:
//   1. URL verification handshake on first save — echo back the `challenge`.
//   2. Signed event_callback payloads — verify signature, ack within 3s.
//   3. Anything else — 200 ok so Slack doesn't retry.
//
// Heavy work (Claude classification, task creation) belongs out of this
// handler — Slack times out at 3s and will retry on non-2xx. For now we just
// pass URL verification and stub the event handler.

function verifySignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  // Slack signature spec: v0=HMAC-SHA256(secret, "v0:" + timestamp + ":" + raw_body)
  const sig = crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const expected = `v0=${sig}`;
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  // Replay protection — reject anything older than 5 minutes.
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 5) {
    return NextResponse.json({ error: "stale or missing timestamp" }, { status: 401 });
  }

  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "SLACK_SIGNING_SECRET not configured on this deploy" },
      { status: 500 }
    );
  }

  if (!verifySignature(rawBody, timestamp, signature, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Minimal shape of the bits we read off Slack's payload. Slack sends a
  // much larger object; we only care about the verification handshake and
  // inbound channel messages.
  interface SlackEventEnvelope {
    type?: string;
    challenge?: string;
    event?: {
      type?: string;
      subtype?: string;
      text?: string;
      channel?: string;
      ts?: string;
    };
  }
  let payload: SlackEventEnvelope;
  try {
    payload = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Step 1 — URL verification on first save in the Slack dashboard.
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Step 2 — real event delivery. Ack fast (Slack times out at 3s and
  // retries on non-2xx); the actual routing runs fire-and-forget. This
  // app runs as a persistent process (see src/instrumentation.ts's
  // in-process scheduler), so detached work completes after the response.
  // Duplicate deliveries / retries are idempotent — site-health routing
  // keys off the Slack message ts (unique in site_health_alerts).
  if (payload.type === "event_callback") {
    const event = payload.event;
    // Channel messages from the monitoring workflow. Skip edits/deletes
    // and our own bot echoes, but allow bot_message (n8n posts as a bot).
    if (
      event &&
      event.type === "message" &&
      (!event.subtype || event.subtype === "bot_message") &&
      typeof event.text === "string" &&
      typeof event.channel === "string" &&
      typeof event.ts === "string"
    ) {
      void routeChannelAlert({
        channelId: event.channel,
        messageTs: event.ts,
        text: event.text
      }).catch((err) => console.error("[slack/events] routeChannelAlert threw:", err));
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}

// Slack only POSTs here, but a GET makes Railway's health checks happy and
// gives a quick "is this deployed?" smoke test.
export async function GET() {
  return NextResponse.json({ ok: true, route: "slack/events" });
}
