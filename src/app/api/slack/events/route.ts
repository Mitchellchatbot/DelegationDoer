import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

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

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Step 1 — URL verification on first save in the Slack dashboard.
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Step 2 — real event delivery. Ack fast; defer real work until the
  // classifier + task pipeline lands.
  if (payload.type === "event_callback") {
    // TODO: enqueue payload.event for async processing:
    //   - filter by source (DMs + channels you watch)
    //   - heuristic gate (imperative cues)
    //   - batched Haiku classification
    //   - create task if classified as task-for-you
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}

// Slack only POSTs here, but a GET makes Railway's health checks happy and
// gives a quick "is this deployed?" smoke test.
export async function GET() {
  return NextResponse.json({ ok: true, route: "slack/events" });
}
