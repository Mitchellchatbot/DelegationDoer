// Auto-archive sweep — the DB side of the archive policy. Pulled out of the
// cron route so BOTH callers share one implementation, mirroring how
// email-intake-runner.ts is shared by /api/cron/email-intake and
// email-intake-bootstrap:
//   - /api/cron/archive-done  (Vercel cron + manual/debug entrypoint, incl. dryRun)
//   - task-archive-bootstrap  (in-process daily loop on Railway / non-Vercel hosts)
//   - /api/tasks/archive-sweep (one-click admin action)
//
// The age rules live in task-archive.ts (pure shouldAutoArchive). This module
// is the queries + UPDATE around them. Two independent triggers archive a task:
//   1. done & completed_at older than the done-window (ARCHIVE_AFTER_DAYS), and
//   2. OPEN (not-done) & due_date older than the overdue-window, which is
//      configurable via workspace_settings.overdue_archive_days.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isTeamTask } from "@/lib/task-team";
import {
  ARCHIVE_AFTER_DAYS,
  OVERDUE_ARCHIVE_DAYS,
  archiveCutoffIso
} from "@/lib/task-archive";

export type ArchiveReason = "done-aged" | "overdue";

export interface ArchiveSweepCandidate {
  id: string;
  title: string;
  reason: ArchiveReason;
  completedAt: string | null;
  dueDate: string | null;
}

export interface ArchiveSweepResult {
  ok: true;
  mode: "dry-run" | "archived";
  doneWindowDays: number;
  overdueWindowDays: number;
  doneCutoff: string;
  overdueCutoff: string;
  // dry-run: how many WOULD archive. archived: how many were archived.
  count: number;
  // Populated only on a dry run, so the preview can list the candidates.
  tasks?: ArchiveSweepCandidate[];
}

// How many days past its due date an OPEN task may sit before it auto-archives.
// Read from the workspace_settings singleton (mirrors site-alert-routing's
// low_site_score_threshold read); falls back to OVERDUE_ARCHIVE_DAYS.
async function getOverdueArchiveDays(): Promise<number> {
  const { data } = await getSupabaseAdmin()
    .from("workspace_settings")
    .select("overdue_archive_days")
    .eq("id", "workspace")
    .maybeSingle();
  const raw = data?.overdue_archive_days as number | null | undefined;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : OVERDUE_ARCHIVE_DAYS;
}

// Archive every task caught by either rule. `dryRun` returns the candidates
// without writing anything — the cheapest way to verify the rules against live
// data. Throws on a DB error so callers can decide how to surface it (the route
// → 500, the loop → logged + retried next tick), matching pollEmailIntake's
// throwing contract.
export async function runArchiveSweep(opts: { dryRun?: boolean } = {}): Promise<ArchiveSweepResult> {
  const dryRun = opts.dryRun ?? false;
  const supabase = getSupabaseAdmin();
  const now = Date.now();
  const overdueWindowDays = await getOverdueArchiveDays();
  const doneCutoff = archiveCutoffIso(now, ARCHIVE_AFTER_DAYS);
  const overdueCutoff = archiveCutoffIso(now, overdueWindowDays);

  // Rule 1 — done & aged. Date filter (plus the partial index on completed_at)
  // keeps this cheap as history grows.
  const { data: doneRows, error: doneErr } = await supabase
    .from("tasks")
    .select("id, title, completed_at, due_date")
    .eq("status", "done")
    .eq("is_draft", false)
    .is("archived_at", null)
    .is("deleted_at", null)
    .not("completed_at", "is", null)
    .lte("completed_at", doneCutoff);
  if (doneErr) throw new Error(doneErr.message);

  // Rule 2 — open & overdue. Any non-done status with a due date more than the
  // (configurable) overdue window in the past. Done tasks are excluded — rule 1
  // governs them — so the two result sets never overlap.
  //
  // assignee_id + tags are selected so unclaimed TEAM tasks can be filtered
  // out below. The sweep writes archived_by: null and no activity_logs row,
  // so archiving work nobody has picked up yet would remove it from the board
  // with no owner to notice and no audit trail. It stays visible and overdue
  // until a human claims, reassigns or deletes it. This mirrors the carve-out
  // in shouldAutoArchive (lib/task-archive.ts) — the two implement the same
  // rules separately, so they have to move together.
  const { data: overdueRowsRaw, error: overdueErr } = await supabase
    .from("tasks")
    .select("id, title, completed_at, due_date, assignee_id, tags, department_id")
    .neq("status", "done")
    .eq("is_draft", false)
    .is("archived_at", null)
    .is("deleted_at", null)
    .not("due_date", "is", null)
    .lte("due_date", overdueCutoff);
  if (overdueErr) throw new Error(overdueErr.message);
  // Filtered here rather than in the query: expressing "not (unassigned AND
  // tagged)" as a PostgREST `or` string is doable but unreadable, and this set
  // is already bounded by the due-date cutoff.
  //
  // Goes through isTeamTask rather than checking the tag inline so this can't
  // drift from lib/task-team.ts — an inline tag check silently disagreed with
  // it on a tagged row that has no department_id.
  const overdueRows = (overdueRowsRaw ?? []).filter(
    (r) =>
      r.assignee_id != null ||
      !isTeamTask({
        departmentId: (r.department_id as string | null) ?? null,
        tags: (r.tags as string[] | null) ?? []
      })
  );

  // Merge, de-duping by id defensively (the status filters already make the
  // sets disjoint). First-seen reason wins.
  const byId = new Map<string, ArchiveSweepCandidate>();
  for (const r of doneRows ?? []) {
    byId.set(r.id as string, {
      id: r.id as string,
      title: r.title as string,
      reason: "done-aged",
      completedAt: (r.completed_at as string | null) ?? null,
      dueDate: (r.due_date as string | null) ?? null
    });
  }
  for (const r of overdueRows ?? []) {
    if (byId.has(r.id as string)) continue;
    byId.set(r.id as string, {
      id: r.id as string,
      title: r.title as string,
      reason: "overdue",
      completedAt: (r.completed_at as string | null) ?? null,
      dueDate: (r.due_date as string | null) ?? null
    });
  }
  const candidates = Array.from(byId.values());

  const base = {
    ok: true as const,
    doneWindowDays: ARCHIVE_AFTER_DAYS,
    overdueWindowDays,
    doneCutoff,
    overdueCutoff
  };

  if (dryRun) {
    return { ...base, mode: "dry-run", count: candidates.length, tasks: candidates };
  }

  const ids = candidates.map((c) => c.id);
  if (ids.length === 0) {
    return { ...base, mode: "archived", count: 0 };
  }

  const stamp = new Date().toISOString();
  // archived_by left NULL = "archived by the system", distinguishing the
  // automated sweep from a manual archive (which records the actor). We don't
  // write an activity_logs row here: that table's user_id is NOT NULL and the
  // sweep has no acting user — the archived_at/null-archived_by stamp is itself
  // the durable record of an automated archive (and last_activity_at moves so
  // the change is visible). Reopening clears the stamp (see the PATCH route).
  const { error: upErr } = await supabase
    .from("tasks")
    .update({ archived_at: stamp, archived_by: null, last_activity_at: stamp })
    .in("id", ids);
  if (upErr) throw new Error(upErr.message);

  return { ...base, mode: "archived", count: ids.length };
}
