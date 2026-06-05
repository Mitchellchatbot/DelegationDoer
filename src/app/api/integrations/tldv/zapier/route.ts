import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runTldvIntake } from "@/lib/tldv-intake";
import { getTranscript, normalizeTldvTranscript } from "@/lib/tldv-client";

export const dynamic = "force-dynamic";
// Pulling a transcript + classifying + N inserts is the slow part; the
// HTTP ack itself is cheap. 60s matches the webhook + run-once handlers.
export const maxDuration = 60;

// POST /api/integrations/tldv/zapier
//
// Zapier-as-relay entry point. Zapier triggers off tl;dv's "Transcript
// Ready" event, then POSTs us a minimal body containing just the
// meeting id. We fetch the full transcript ourselves via tl;dv's API
// and run the existing intake pipeline — so this path always works
// with fresh, complete data, regardless of how Zapier reshaped the
// trigger output.
//
// Why a separate endpoint from /webhook? Two reasons:
//   1. Zapier's tl;dv trigger gives us flat fields, not the nested
//      JSON tl;dv's webhook sends. Letting Zapier hand-assemble that
//      JSON is fragile. Easier to accept { meetingId } and fetch fresh.
//   2. We can rotate the Zapier secret independently from the direct
//      tl;dv webhook secret. Either path can be disabled without
//      affecting the other.
//
// Auth: ZAPIER_WEBHOOK_SECRET, sent as `x-zapier-webhook-secret` header.
// Falls back to TLDV_WEBHOOK_SECRET if ZAPIER_WEBHOOK_SECRET isn't set,
// so a single shared secret works during initial setup.
//
// Body: { meetingId: string } — all we need.
//
// Dedup: tldv_intake_log keyed on meeting_id, so Zapier retries on the
// same meeting are no-ops (same guarantee as the direct webhook).

function log(...args: unknown[]) {
  console.log("[tldv-zapier]", ...args);
}
function warn(...args: unknown[]) {
  console.warn("[tldv-zapier]", ...args);
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  // 1) Verify the shared secret. Prefer the Zapier-specific env so it
  //    can be rotated separately; fall back to TLDV_WEBHOOK_SECRET so
  //    setup works with the existing secret.
  const expected = process.env.ZAPIER_WEBHOOK_SECRET || process.env.TLDV_WEBHOOK_SECRET;
  if (!expected) {
    warn("rejected: neither ZAPIER_WEBHOOK_SECRET nor TLDV_WEBHOOK_SECRET configured");
    return NextResponse.json(
      { error: "ZAPIER_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }
  const presented = req.headers.get("x-zapier-webhook-secret")
    ?? req.headers.get("x-tldv-webhook-secret");
  if (presented !== expected) {
    warn("rejected: bad/missing x-zapier-webhook-secret header");
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2) Parse body. Two supported shapes:
  //   (a) { meetingId } — fetch transcript fresh from tl;dv's API
  //   (b) { meetingName, transcript, meetingUrl? } — Zapier's tl;dv
  //       trigger doesn't always expose the meeting ID; the transcript
  //       text is the actual payload. We use it directly and synthesize
  //       a stable meetingId from a content hash so dedupe still works.
  //
  // Body format: JSON or form-encoded. Zapier users who paste raw JSON
  // into the Data field hit "bad json" the moment a transcript contains
  // unescaped quotes or newlines — accepting form-encoded sidesteps
  // that entirely (just set Payload Type to "form" in Zapier).
  //
  // Field names are forgiving — Zapier's flat-field output uses snake_case
  // some of the time. transcript / transcriptText / transcript_text all
  // accepted.
  let body: Record<string, unknown> = {};
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        body[k] = typeof v === "string" ? v : String(v);
      }
    } catch {
      warn("rejected: body is not valid form-encoded data");
      return NextResponse.json({ error: "bad form data" }, { status: 400 });
    }
  } else {
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      warn("rejected: body is not valid JSON (tip: in Zapier, use the key/value editor instead of pasting raw JSON, or switch Payload Type to 'form')");
      return NextResponse.json(
        { error: "bad json — use Zapier's structured Data editor, or switch Payload Type to 'form'" },
        { status: 400 }
      );
    }
  }

  const rawMeetingId =
    typeof body.meetingId === "string" ? body.meetingId.trim() :
    typeof body.meeting_id === "string" ? body.meeting_id.trim() :
    typeof body.id === "string" ? body.id.trim() :
    "";
  const directTranscript =
    typeof body.transcript === "string" ? body.transcript :
    typeof body.transcriptText === "string" ? body.transcriptText :
    typeof body.transcript_text === "string" ? body.transcript_text :
    "";
  const meetingName =
    typeof body.meetingName === "string" ? body.meetingName.trim() :
    typeof body.meeting_name === "string" ? body.meeting_name.trim() :
    typeof body.name === "string" ? body.name.trim() :
    typeof body.title === "string" ? body.title.trim() :
    "";

  // Dump the field names we got so we can spot mapping mistakes from
  // Zapier's side without forcing the user to add a Storage step.
  log(`body keys=[${Object.keys(body).join(",")}]`);

  if (!rawMeetingId && !directTranscript) {
    warn(`rejected: payload missing both meetingId AND transcript (received keys: ${Object.keys(body).join(",") || "(none)"})`);
    return NextResponse.json(
      {
        error: "either meetingId (to fetch from tl;dv) or transcript (raw text) is required",
        receivedKeys: Object.keys(body),
        hint: "Map Zapier's 'Transcript' field to `transcript` OR the 'Meeting ID' field to `meetingId`."
      },
      { status: 400 }
    );
  }

  // 3) Get the transcript either by fetching from tl;dv (if we have an
  //    id) or by trusting Zapier's direct passthrough.
  let transcript = "";
  let segments: ReturnType<typeof normalizeTldvTranscript>["segments"] = [];
  let rawPayload: unknown = body;
  let meetingId = rawMeetingId;

  if (directTranscript) {
    transcript = directTranscript;
    // No segments when Zapier hands us flat text; the classifier works
    // off the transcript string alone so that's fine.
    if (!meetingId) {
      // Stable, content-derived ID so a Zapier retry on the same meeting
      // hits the tldv_intake_log dedupe path. 16 hex chars (~64 bits) is
      // plenty of collision resistance for this volume.
      const hash = createHash("sha256")
        .update(`${meetingName}\n${directTranscript.slice(0, 4000)}`)
        .digest("hex")
        .slice(0, 16);
      meetingId = `zap_${hash}`;
    }
    log(`received via zapier passthrough: meetingId=${meetingId} name="${meetingName || "-"}" transcript=${transcript.length}chars`);
  } else {
    // Classic Option-B path: have meetingId, fetch from tl;dv API.
    log(`received meetingId=${meetingId} — fetching transcript from tl;dv`);
    let transcriptResponse;
    try {
      transcriptResponse = await getTranscript(meetingId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`meetingId=${meetingId}: tl;dv transcript fetch failed: ${msg}`);
      // 503 so Zapier auto-retries with backoff.
      return NextResponse.json(
        { error: `tl;dv fetch failed: ${msg}` },
        { status: 503 }
      );
    }
    const normalized = normalizeTldvTranscript(transcriptResponse.data);
    transcript = normalized.transcript;
    segments = normalized.segments;
    rawPayload = transcriptResponse;
    if (segments.length === 0 && transcript.length === 0) {
      warn(`meetingId=${meetingId}: normalizer returned 0 segments AND empty transcript — tl;dv API returned nothing usable. 200ing so Zapier doesn't retry forever.`);
    } else {
      log(`meetingId=${meetingId}: parsed segments=${segments.length} transcript=${transcript.length}chars`);
    }
  }

  // 4) Hand off to the shared pipeline.
  try {
    const outcome = await runTldvIntake({
      meetingId,
      webhookId: null,
      transcript,
      segments,
      rawPayload,
      source: "zapier",
      // Zapier's tl;dv trigger surfaces the meeting name as a flat field;
      // pass it through as the stored meeting title when present.
      meetingTitle: meetingName || null
    });

    const elapsed = Date.now() - startedAt;
    if (outcome.skipped === "already-logged") {
      log(`meetingId=${meetingId}: SKIPPED (already logged) in ${elapsed}ms`);
    } else if (outcome.items.length === 0) {
      // Loud no matter where the transcript came from (passthrough OR
      // tl;dv-fetched). Before, this only fired when segments.length>0,
      // so Zapier passthrough silently swallowed every empty-classify.
      warn(`meetingId=${meetingId}: classifier extracted 0 action items from transcript=${transcript.length}chars (verify raw_payload in tldv_intake_log)`);
    } else if (outcome.items.length > 0 && !outcome.clientMatched) {
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
      // Diagnostic block so Zapier's test panel shows what landed.
      // If itemsCreated=0 the message points the user at the most
      // likely cause without forcing them to dig through Railway logs.
      diagnostics: {
        transcriptChars: transcript.length,
        segments: segments.length,
        zapierMappedKeys: Object.keys(body),
        note: outcome.items.length === 0
          ? "Classifier found no concrete action items in this transcript. Check Railway logs (`[tldv-zapier]`) for the raw_payload, or inspect tldv_intake_log for this meetingId."
          : undefined
      },
      items: outcome.items.map((i) => ({
        taskId: i.taskId,
        title: i.title,
        routedVia: i.routedVia,
        routedToUserId: i.routedToUserId
      }))
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    warn(`meetingId=${meetingId}: pipeline threw "${msg}" — returning 500 so Zapier retries`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
