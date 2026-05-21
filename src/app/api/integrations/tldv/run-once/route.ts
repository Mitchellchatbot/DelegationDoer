import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getTranscript, normalizeTldvTranscript } from "@/lib/tldv-client";
import { runTldvIntake } from "@/lib/tldv-intake";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/integrations/tldv/run-once
//   body: { meetingId: string }
//
// Manual replay path — fetches the transcript from tl;dv's GET endpoint
// and runs the shared pipeline. Bypasses the tldv_intake_log dedupe
// (source: "manual") so you can re-process a meeting after fixing a
// classifier prompt or routing rule.
//
// Auth: any signed-in user (Leader-only would be more conservative, but
// the worst case is "I spawned the same meeting's drafts twice" — the
// dept head still has to approve each one).
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const meetingId = typeof body.meetingId === "string" ? body.meetingId.trim() : "";
    if (!meetingId) {
      return NextResponse.json({ error: "meetingId required" }, { status: 400 });
    }

    // Pull the transcript fresh from tl;dv. The GET endpoint 400s if the
    // transcript isn't complete yet — surface that as-is so the caller
    // can retry.
    let transcriptResponse;
    try {
      transcriptResponse = await getTranscript(meetingId);
    } catch (err) {
      return NextResponse.json(
        { error: `tl;dv fetch failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }

    // tl;dv's GET response uses the same polymorphic `data.data` shape
    // as the webhook (array of segments in real meetings, wrapped object
    // in mocks). Normalize before handing to the intake pipeline.
    const { transcript, segments } = normalizeTldvTranscript(transcriptResponse.data);

    const outcome = await runTldvIntake({
      meetingId,
      webhookId: null,
      transcript,
      segments,
      rawPayload: transcriptResponse,
      source: "manual"
    });

    return NextResponse.json({
      ok: true,
      meetingId: outcome.meetingId,
      clientName: outcome.clientName,
      itemsCreated: outcome.items.length,
      resourceId: outcome.resourceId,
      items: outcome.items
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
