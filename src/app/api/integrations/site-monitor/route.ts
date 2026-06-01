import { NextRequest, NextResponse } from "next/server";
import { routeSiteHealthAlertWebhook } from "@/lib/site-alert-routing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/site-monitor
//
// Direct webhook for the n8n website-monitoring workflow. Since n8n is
// already the thing producing the alert, this lets it POST the alert to us
// straight — no Slack Events API config, bot scopes, or channel membership
// required (that's the /api/slack/events path). Both paths funnel into the
// same routeSiteHealthAlert* core in src/lib/site-alert-routing.ts.
//
// Auth: SITE_MONITOR_WEBHOOK_SECRET, sent as `x-site-monitor-secret`.
//
// Body (JSON or form-encoded — same forgiveness as the tl;dv zapier route):
//   Structured (preferred):
//     { "website": "https://example.com/", "score": 65, "id": "<stable id>" }
//   …or raw alert text (the exact string posted to Slack):
//     { "text": "Alert: https://example.com/ is slow! Score: 65", "id": "..." }
//   Field aliases accepted: website/url/site · score/site_score · text/message/alert
//                           · id/alertId/messageId/eventId
//
// `id` is the idempotency key — pass a stable value (the Slack message ts,
// or the n8n execution id) so retries are no-ops. If omitted we derive one
// from domain + score, which dedupes redeliveries of the same alert.
//
// Dedup: site_health_alerts unique (source, source_event_id) — same
// guarantee as the Slack path.

function warn(...args: unknown[]) {
  console.warn("[site-monitor]", ...args);
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function toScore(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  // 1) Shared-secret check.
  const expected = process.env.SITE_MONITOR_WEBHOOK_SECRET;
  if (!expected) {
    warn("rejected: SITE_MONITOR_WEBHOOK_SECRET not configured on this deploy");
    return NextResponse.json(
      { error: "SITE_MONITOR_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }
  const presented = req.headers.get("x-site-monitor-secret");
  if (presented !== expected) {
    warn("rejected: bad/missing x-site-monitor-secret header");
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2) Parse body — accept JSON or form-encoded (n8n can send either).
  let body: Record<string, unknown> = {};
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const form = await req.formData();
      for (const [k, v] of form.entries()) body[k] = typeof v === "string" ? v : String(v);
    } catch {
      return NextResponse.json({ error: "bad form data" }, { status: 400 });
    }
  } else {
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
  }

  const website = firstString(body.website, body.url, body.site);
  const score = toScore(body.score, body.site_score);
  const text = firstString(body.text, body.message, body.alert);
  const id = firstString(body.id, body.alertId, body.messageId, body.eventId);

  if (!text && !(website && score !== undefined)) {
    return NextResponse.json(
      {
        error: "provide either { website, score } or { text }",
        receivedKeys: Object.keys(body)
      },
      { status: 400 }
    );
  }

  // 3) Hand off to the shared core.
  try {
    const outcome = await routeSiteHealthAlertWebhook({
      website,
      score: score ?? null,
      text: text ?? null,
      id: id ?? null,
      reference: text ?? website ?? null
    });

    if (!outcome.handled && outcome.reason === "no-match") {
      return NextResponse.json(
        { ok: false, reason: "no-match", note: "Couldn't parse a site URL + score from the payload." },
        { status: 422 }
      );
    }
    if (!outcome.handled && outcome.reason === "error") {
      // 500 so n8n retries.
      return NextResponse.json({ ok: false, error: outcome.detail }, { status: 500 });
    }
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    warn(`pipeline threw "${msg}" — returning 500 so n8n retries`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET for a quick "is this deployed?" smoke test (and Railway health checks).
export async function GET() {
  return NextResponse.json({ ok: true, route: "integrations/site-monitor" });
}
