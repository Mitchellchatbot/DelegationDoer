// Server-side typed wrapper around the tl;dv API.
// All calls go through `tldvFetch` which adds the x-api-key header and
// surfaces non-2xx responses with a useful error string.
//
// Required env vars:
//   TLDV_API_KEY  — API key from https://tldv.io/app/settings/api
//
// The webhook is the primary integration path — see
// /api/integrations/tldv/webhook. This client is for replay /
// run-once / cases where the webhook arrives before the transcript is
// finalized server-side and we need to re-fetch.

const TLDV_BASE_URL = "https://pasta.tldv.io";

// One transcript line. Real tl;dv payloads include `speaker` — the
// docs at one point claimed segments were just text+timestamps, but
// production webhooks attach speaker attribution which the classifier
// uses to keep "Sarah asked Tom to do X" intact.
export interface TldvTranscriptSegment {
  startTime: number; // seconds from meeting start
  endTime: number;
  text: string;
  speaker?: string;
}

// Wrapped shape that test events + the docs example use.
export interface TldvTranscriptWrapped {
  transcript: string;
  segments: TldvTranscriptSegment[];
}

// The `data` envelope in the webhook (GetTranscriptByMeetingIdResponse).
// `data.data` is polymorphic in the wild:
//   - real tl;dv webhooks send an ARRAY of segments directly
//   - tl;dv dashboard test events + our smoke tests use the wrapped object
// Always pipe `data.data` through `normalizeTldvTranscript` before use.
export interface TldvMeetingTranscriptResponse {
  id: string;
  meetingId: string;
  data: TldvTranscriptSegment[] | TldvTranscriptWrapped;
}

// Reconcile both shapes into { transcript, segments }. Builds a
// speaker-prefixed transcript string when only segments are present so
// the classifier always has something readable to work with.
export function normalizeTldvTranscript(
  rawData: unknown
): { transcript: string; segments: TldvTranscriptSegment[] } {
  if (Array.isArray(rawData)) {
    const segments = rawData as TldvTranscriptSegment[];
    return { segments, transcript: joinWithSpeakers(segments) };
  }
  if (rawData && typeof rawData === "object") {
    const obj = rawData as Partial<TldvTranscriptWrapped>;
    const segments = obj.segments ?? [];
    const transcript =
      (obj.transcript && obj.transcript.length > 0)
        ? obj.transcript
        : joinWithSpeakers(segments);
    return { segments, transcript };
  }
  return { segments: [], transcript: "" };
}

function joinWithSpeakers(segments: TldvTranscriptSegment[]): string {
  return segments
    .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
    .join("\n");
}

// The full webhook body. Validate against this shape in the route.
export interface TldvWebhookPayload {
  id: string;          // webhook payload id, e.g. "webhook-456"
  event: "TranscriptReady" | string;
  data: TldvMeetingTranscriptResponse;
  executedAt?: string; // ISO timestamp; docs say required, real payloads sometimes omit
}

function apiKey(): string {
  const k = process.env.TLDV_API_KEY;
  if (!k) throw new Error("TLDV_API_KEY not set");
  return k;
}

async function tldvFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${TLDV_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      ...(init.headers ?? {})
    },
    cache: "no-store"
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tldv ${path} → ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// GET /v1alpha1/meetings/{meetingId}/transcript
//   Returns the transcript only if it's complete; tl;dv 400s otherwise.
//   We use this for run-once replay and as a recovery path if the
//   webhook payload arrives without the transcript.
export async function getTranscript(
  meetingId: string
): Promise<TldvMeetingTranscriptResponse> {
  return tldvFetch<TldvMeetingTranscriptResponse>(
    `/v1alpha1/meetings/${encodeURIComponent(meetingId)}/transcript`
  );
}
