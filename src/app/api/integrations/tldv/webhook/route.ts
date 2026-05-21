import { NextRequest, NextResponse } from "next/server";
import { runTldvIntake } from "@/lib/tldv-intake";
import { normalizeTldvTranscript, type TldvWebhookPayload } from "@/lib/tldv-client";

export const dynamic = "force-dynamic";
// tl;dv expects a fast ack; classify + N task inserts is the slow part.
// 60s is the Vercel hard cap on the hobby tier; bump if you go pro.
export const maxDuration = 60;

// POST /api/integrations/tldv/webhook
//
// Receives tl;dv's TranscriptReady webhook. Real payloads put segments
// directly at `data.data` as an ARRAY (with speaker attribution per
// segment) — the docs example used a wrapped { transcript, segments }
// object which test events still use. normalizeTldvTranscript() handles
// both shapes.
//
// Auth: TLDV_WEBHOOK_SECRET, sent as `x-tldv-webhook-secret` header.
// (tl;dv's webhook config screen lets you paste arbitrary headers — we
// use a shared-secret header rather than HMAC for simplicity.)
export async function POST(req: NextRequest) {
  // 1) Verify the shared secret. If TLDV_WEBHOOK_SECRET isn't set, the
  //    endpoint refuses all traffic — fail closed.
  const expected = process.env.TLDV_WEBHOOK_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "TLDV_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }
  const presented = req.headers.get("x-tldv-webhook-secret");
  if (presented !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2) Parse + minimally validate.
  let payload: TldvWebhookPayload;
  try {
    payload = (await req.json()) as TldvWebhookPayload;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // We only care about TranscriptReady. Acknowledge other events with
  // 200 so tl;dv doesn't retry them, but skip processing.
  if (payload?.event !== "TranscriptReady") {
    return NextResponse.json({ ok: true, ignored: payload?.event ?? "unknown" });
  }

  const meeting = payload.data;
  const meetingId = meeting?.meetingId || meeting?.id;
  if (!meetingId) {
    return NextResponse.json({ error: "missing meetingId" }, { status: 400 });
  }
  const { transcript, segments } = normalizeTldvTranscript(meeting?.data);

  // 3) Hand off to the shared pipeline.
  try {
    const outcome = await runTldvIntake({
      meetingId,
      webhookId: payload.id ?? null,
      transcript,
      segments,
      rawPayload: payload,
      source: "webhook"
    });
    return NextResponse.json({
      ok: true,
      meetingId: outcome.meetingId,
      skipped: outcome.skipped,
      clientName: outcome.clientName,
      itemsCreated: outcome.items.length,
      resourceId: outcome.resourceId,
      items: outcome.items.map((i) => ({
        taskId: i.taskId,
        title: i.title,
        routedVia: i.routedVia,
        routedToUserId: i.routedToUserId
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
