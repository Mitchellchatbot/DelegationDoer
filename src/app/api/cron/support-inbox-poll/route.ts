import { NextResponse } from "next/server";
import { runSupportInboxPoll } from "@/lib/support-inbox-poller";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/support-inbox-poll
//
// Sweeps the Blooio API for inbound SMS and ingests them into the
// customer-support tables (classify + route via lib/support-intake.ts). Same
// runner the in-process scheduler ticks every minute (cron-bootstrap.ts) — the
// runner is idempotent on support_messages.blooio_message_id, so a manual hit
// racing the scheduler can't double-process.
//
// `?days=N` widens the lookback for a one-time HISTORICAL BACKFILL. The default
// 24h window only recovers recent drops, so inbound that predates go-live (e.g.
// replies received before the CS feature shipped) is invisible until a wide
// sweep re-offers it:
//   GET /api/cron/support-inbox-poll            → normal 24h sweep
//   GET /api/cron/support-inbox-poll?days=3650  → full historical backfill
// The per-run caps (MAX_CHATS/MAX_CLASSIFY in the poller) mean a large backlog
// may need the route re-run to drain; each run is a cheap no-op on already-seen
// messages.
//
// While inbound capture is disabled (lib/blooio.ts isBlooioInboundEnabled) the
// runner does nothing and the response carries skipped:"inbound-disabled" — a
// backfill included. That is deliberate, not a bug: the Blooio org is shared
// with the New Life CRM, so a sweep would ingest their conversations too.
export async function GET(req: Request) {
  try {
    const days = Number(new URL(req.url).searchParams.get("days")) || 0;
    const opts =
      days > 0 ? { lookbackMs: days * 24 * 60 * 60 * 1000 } : undefined;
    const r = await runSupportInboxPoll(opts);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
