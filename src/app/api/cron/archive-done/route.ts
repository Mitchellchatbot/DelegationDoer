import { NextRequest, NextResponse } from "next/server";
import { runArchiveSweep } from "@/lib/task-archive-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/archive-done — auto-archives tasks finished more than
// ARCHIVE_AFTER_DAYS (7) days ago, so the active "Done" column only ever shows
// recently-completed work.
//
// On Vercel this is driven by vercel.json's daily cron. On Railway / any
// long-lived host the SAME sweep is scheduled in-process by
// task-archive-bootstrap (which stands down on Vercel so the two never
// double-run). This route remains the manual / debug entrypoint either way.
//
// Auth: same convention as the other crons — Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; we also accept `?secret=` so the
// route is debuggable from a browser. When CRON_SECRET is unset (local dev)
// the gate is skipped.
//
// Safety / observability:
//   - `?dryRun=true` returns the tasks that WOULD be archived without writing
//     anything — the cheapest way to verify the rule against live data.
//   - The archive is a plain UPDATE (archived_by stays NULL to mark it as an
//     automated archive). Nothing is deleted; everything stays recoverable
//     via the Archived view's Unarchive button.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const querySecret = url.searchParams.get("secret");
    const ok = auth === `Bearer ${secret}` || querySecret === secret;
    if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const dryRun = url.searchParams.get("dryRun") === "true";
  try {
    const result = await runArchiveSweep({ dryRun });
    if (result.mode === "dry-run") {
      return NextResponse.json({
        ok: true,
        mode: "dry-run",
        windowDays: result.windowDays,
        cutoff: result.cutoff,
        wouldArchive: result.count,
        tasks: result.tasks
      });
    }
    return NextResponse.json({ ok: true, archived: result.count, cutoff: result.cutoff });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
