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
// Every line below is prefixed with `[tldv-webhook]` so Railway log search
// for that string surfaces the full life of any inbound webhook in one go.
// Without these, Next.js prints nothing on a successful 200 — meaning a
// silent "0 items extracted" failure (the 21:32 incident) goes undetected
// until someone checks the DB.
function log(...args: unknown[]) {
  console.log("[tldv-webhook]", ...args);
}
function warn(...args: unknown[]) {
  console.warn("[tldv-webhook]", ...args);
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  // 1) Verify the shared secret. If TLDV_WEBHOOK_SECRET isn't set, the
  //    endpoint refuses all traffic — fail closed.
  const expected = process.env.TLDV_WEBHOOK_SECRET;
  if (!expected) {
    warn("rejected: TLDV_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "TLDV_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }
  const presented = req.headers.get("x-tldv-webhook-secret");
  if (presented !== expected) {
    warn("rejected: bad/missing x-tldv-webhook-secret header");
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2) Parse + minimally validate.
  let payload: TldvWebhookPayload;
  try {
    payload = (await req.json()) as TldvWebhookPayload;
  } catch {
    warn("rejected: body is not valid JSON");
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // We only care about TranscriptReady. Acknowledge other events with
  // 200 so tl;dv doesn't retry them, but skip processing.
  if (payload?.event !== "TranscriptReady") {
    log(`ignored event="${payload?.event ?? "unknown"}" (only TranscriptReady is processed)`);
    return NextResponse.json({ ok: true, ignored: payload?.event ?? "unknown" });
  }

  const meeting = payload.data;
  const meetingId = meeting?.meetingId || meeting?.id;
  if (!meetingId) {
    warn("rejected: payload missing data.meetingId AND data.id");
    return NextResponse.json({ error: "missing meetingId" }, { status: 400 });
  }

  // Inspect the shape of meeting.data before normalizing so we can tell
  // — from logs alone — whether tl;dv changed their payload schema.
  const dataField = meeting?.data;
  const dataShape = Array.isArray(dataField)
    ? `array(${dataField.length})`
    : (dataField && typeof dataField === "object"
        ? `object{${Object.keys(dataField as unknown as Record<string, unknown>).join(",")}}`
        : `${typeof dataField}`);
  log(`received meetingId=${meetingId} webhookId=${payload.id ?? "-"} dataShape=${dataShape}`);

  const { transcript, segments } = normalizeTldvTranscript(meeting?.data);

  if (segments.length === 0 && transcript.length === 0) {
    warn(`meetingId=${meetingId}: normalizer returned 0 segments AND empty transcript — payload shape may have changed (got ${dataShape}). Still 200ing so tl;dv doesn't retry, but no tasks will be created.`);
  } else {
    log(`meetingId=${meetingId}: parsed segments=${segments.length} transcript=${transcript.length}chars`);
  }

  // 3) Hand off to the shared pipeline.
  try {
    const outcome = await runTldvIntake({
      meetingId,
      webhookId: payload.id ?? null,
      transcript,
      segments,
      rawPayload: payload,
      source: "webhook",
      // tl;dv stamps the event time on the webhook envelope; use it as the
      // meeting date so the Knowledge Base timeline reflects when the
      // meeting happened, not when we processed it.
      occurredAt: payload.executedAt ?? null
    });

    const elapsed = Date.now() - startedAt;
    if (outcome.skipped === "already-logged") {
      log(`meetingId=${meetingId}: SKIPPED (already logged) in ${elapsed}ms`);
    } else if (outcome.items.length === 0 && segments.length > 0) {
      // Loud signal — non-empty meeting transcripts that yield 0 items
      // could be genuine small-talk OR a sign the classifier prompt /
      // payload shape needs attention. Either way, worth a look.
      warn(`meetingId=${meetingId}: classifier extracted 0 items from ${segments.length} segments (classifier judged transcript had no concrete commitments — verify by inspecting raw_payload in tldv_intake_log)`);
    } else if (outcome.items.length > 0 && !outcome.clientMatched) {
      // Tasks created but no client matched — brief is NOT stored anywhere.
      // Loud so the empty Meetings & briefs timeline doesn't go unnoticed.
      warn(`meetingId=${meetingId}: itemsCreated=${outcome.items.length} but NO client matched — brief NOT stored. Backfill via POST .../meetings/${meetingId}/backfill in ${elapsed}ms`);
    } else if (outcome.clientMatched && !outcome.meetingStored) {
      warn(`meetingId=${meetingId}: client="${outcome.clientName ?? "-"}" matched but client_meetings WRITE FAILED (${outcome.storeError ?? "unknown"}) — brief NOT stored in ${elapsed}ms`);
    } else {
      log(`meetingId=${meetingId}: itemsCreated=${outcome.items.length} clientName="${outcome.clientName ?? "-"}" stored=${outcome.meetingStored ? "yes" : "no"} resourceId=${outcome.resourceId ?? "-"} in ${elapsed}ms`);
    }

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
    // Return 5xx so tl;dv retries. Logged loudly so we know it happened.
    const msg = err instanceof Error ? err.message : "unknown error";
    warn(`meetingId=${meetingId}: pipeline threw "${msg}" — returning 500 so tl;dv retries`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
