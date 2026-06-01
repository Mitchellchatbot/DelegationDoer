// Auto-archive sweep — the DB side of the archive policy. Pulled out of the
// cron route so BOTH callers share one implementation, mirroring how
// email-intake-runner.ts is shared by /api/cron/email-intake and
// email-intake-bootstrap:
//   - /api/cron/archive-done  (Vercel cron + manual/debug entrypoint, incl. dryRun)
//   - task-archive-bootstrap  (in-process daily loop on Railway / non-Vercel hosts)
//
// The age rule itself lives in task-archive.ts (pure shouldAutoArchive /
// archiveCutoffIso). This module is just the query + UPDATE around it.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ARCHIVE_AFTER_DAYS, archiveCutoffIso } from "@/lib/task-archive";

export interface ArchiveSweepResult {
  ok: true;
  mode: "dry-run" | "archived";
  windowDays: number;
  cutoff: string;
  // dry-run: how many WOULD archive. archived: how many were archived.
  count: number;
  // Populated only on a dry run, so the preview can list the candidates.
  tasks?: { id: string; title: string; completedAt: string | null }[];
}

// Archive every done task completed more than ARCHIVE_AFTER_DAYS (7) days ago.
// `dryRun` returns the candidates without writing anything — the cheapest way
// to verify the rule against live data. Throws on a DB error so callers can
// decide how to surface it (the route → 500, the loop → logged + retried next
// tick), matching pollEmailIntake's throwing contract.
export async function runArchiveSweep(opts: { dryRun?: boolean } = {}): Promise<ArchiveSweepResult> {
  const dryRun = opts.dryRun ?? false;
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
  if (selErr) throw new Error(selErr.message);

  const rows = candidates ?? [];

  if (dryRun) {
    return {
      ok: true,
      mode: "dry-run",
      windowDays: ARCHIVE_AFTER_DAYS,
      cutoff,
      count: rows.length,
      tasks: rows.map((r) => ({ id: r.id as string, title: r.title as string, completedAt: r.completed_at as string | null }))
    };
  }

  const ids = rows.map((r) => r.id as string);
  if (ids.length === 0) {
    return { ok: true, mode: "archived", windowDays: ARCHIVE_AFTER_DAYS, cutoff, count: 0 };
  }

  const now = new Date().toISOString();
  // archived_by left NULL = "archived by the system", distinguishing the
  // automated sweep from a manual archive (which records the actor). We don't
  // write an activity_logs row here: that table's user_id is NOT NULL and the
  // sweep has no acting user — the archived_at/null-archived_by stamp is itself
  // the durable record of an automated archive (and last_activity_at moves so
  // the change is visible). Reopening clears the stamp (see the PATCH route).
  const { error: upErr } = await supabase
    .from("tasks")
    .update({ archived_at: now, archived_by: null, last_activity_at: now })
    .in("id", ids);
  if (upErr) throw new Error(upErr.message);

  return { ok: true, mode: "archived", windowDays: ARCHIVE_AFTER_DAYS, cutoff, count: ids.length };
}
