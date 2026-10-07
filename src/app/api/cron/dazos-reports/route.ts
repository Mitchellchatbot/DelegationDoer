import { NextRequest, NextResponse } from "next/server";
import { sweepDazosReports } from "@/lib/dazos-reports";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/dazos-reports — safety net for the Dazos → dashboard push.
//
// The webhook pushes each CSV the moment the mail lands; this sweep catches
// reports it never saw (missed event, deploy window) and retries pushes that
// failed with a retryable error. Re-posting is harmless — the ingest endpoint
// upserts — so the sweep can run as often as we like.
//
// Auth matches the other crons: Bearer CRON_SECRET, or ?secret= for a browser.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const ok = auth === `Bearer ${secret}` || url.searchParams.get("secret") === secret;
    if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 40;

  try {
    return NextResponse.json(await sweepDazosReports(limit));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
