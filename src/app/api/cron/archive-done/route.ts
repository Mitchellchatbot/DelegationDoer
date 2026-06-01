import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ARCHIVE_AFTER_DAYS, archiveCutoffIso } from "@/lib/task-archive";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/archive-done — daily sweep that auto-archives tasks finished
// more than ARCHIVE_AFTER_DAYS (7) days ago, so the active "Done" column only
// ever shows recently-completed work.
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
  const supabase = getSupabaseAdmin();
  const cutoff = archiveCutoffIso(Date.now());

  // Candidates: done, not yet archived, not deleted, with a completion date
  // at/older than the cutoff. The date filter (plus the partial index on
  // completed_at) keeps this cheap as history grows. The cutoff/age logic
  // matches shouldAutoArchive() — kept here as SQL so we archive in one
  // round-trip rather than fetching every done task first.
  const { data: candidates, error: selErr } = await supabase
    .from("tasks")
    .select("id, title, completed_at")
    .eq("status", "done")
    .eq("is_draft", false)
    .is("archived_at", null)
    .is("deleted_at", null)
    .not("completed_at", "is", null)
    .lte("completed_at", cutoff);
  if (selErr) return NextResponse.json({ ok: false, error: selErr.message }, { status: 500 });

  const rows = candidates ?? [];
  const ids = rows.map((r) => r.id as string);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      mode: "dry-run",
      windowDays: ARCHIVE_AFTER_DAYS,
      cutoff,
      wouldArchive: rows.length,
      tasks: rows.map((r) => ({ id: r.id, title: r.title, completedAt: r.completed_at }))
    });
  }

  if (ids.length === 0) {
    return NextResponse.json({ ok: true, archived: 0, cutoff });
  }

  const now = new Date().toISOString();
  // archived_by left NULL = "archived by the system", distinguishing the
  // automated sweep from a manual archive (which records the actor). We don't
  // write an activity_logs row here: that table's user_id is NOT NULL and the
  // cron has no acting user — the archived_at/null-archived_by stamp is itself
  // the durable record of an automated archive (and last_activity_at moves so
  // the change is visible). Reopening clears the stamp (see the PATCH route).
  const { error: upErr } = await supabase
    .from("tasks")
    .update({ archived_at: now, archived_by: null, last_activity_at: now })
    .in("id", ids);
  if (upErr) return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, archived: ids.length, cutoff });
}
