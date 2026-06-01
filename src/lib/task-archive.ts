// Archive policy — the single source of truth for "should this task drop off
// the active board?" Kept as pure, side-effect-free functions so the daily
// cron, the dry-run preview, and the standalone check script
// (scripts/check-archive.mjs) all agree on the rule.
//
// Two independent triggers (a task archives if EITHER fires):
//   1. Done & aged — status=done and completed more than ARCHIVE_AFTER_DAYS ago.
//   2. Overdue & stale — an OPEN (not-done) task whose due date is more than
//      `overdueAfterDays` in the past. The threshold is configurable in Settings
//      (workspace_settings.overdue_archive_days); OVERDUE_ARCHIVE_DAYS is the
//      fallback default. Done tasks are governed solely by rule 1 — once a task
//      is finished it's no longer "overdue", so this rule skips them.

// How long a finished task may sit in the active "Done" column before it
// auto-archives.
export const ARCHIVE_AFTER_DAYS = 7;

// Default for how many days past its due date an OPEN task may sit before it
// auto-archives as stale. Overridable per-workspace via Settings.
export const OVERDUE_ARCHIVE_DAYS = 10;

const DAY_MS = 86_400_000;

// Minimal shape the rule needs — accepts a full Task or a raw DB row.
export interface ArchivableTask {
  status: string;
  completedAt?: string | null;
  dueDate?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

export interface ArchiveWindows {
  // Done-window: days since completion before a done task archives.
  doneAfterDays?: number;
  // Overdue-window: days past due before an open task archives.
  overdueAfterDays?: number;
}

// True when a task is eligible for AUTO archiving under either rule. `nowMs` is
// injected so the function stays deterministic/testable. Already-archived or
// deleted tasks are never re-touched (archive is idempotent; delete wins).
export function shouldAutoArchive(
  task: ArchivableTask,
  nowMs: number,
  windows: ArchiveWindows = {}
): boolean {
  const doneAfterDays = windows.doneAfterDays ?? ARCHIVE_AFTER_DAYS;
  const overdueAfterDays = windows.overdueAfterDays ?? OVERDUE_ARCHIVE_DAYS;

  if (task.archivedAt) return false; // already archived
  if (task.deletedAt) return false;  // deleted wins; leave it alone

  // Rule 1 — done & aged.
  if (task.status === "done") {
    if (!task.completedAt) return false;          // no completion date → can't age it
    const completedMs = new Date(task.completedAt).getTime();
    if (Number.isNaN(completedMs)) return false;  // unparseable → skip, don't guess
    return nowMs - completedMs >= doneAfterDays * DAY_MS;
  }

  // Rule 2 — open & overdue. Only non-done tasks reach here.
  if (!task.dueDate) return false;                // no due date → nothing to overrun
  const dueMs = new Date(task.dueDate).getTime();
  if (Number.isNaN(dueMs)) return false;          // unparseable → skip, don't guess
  return nowMs - dueMs >= overdueAfterDays * DAY_MS;
}

// ISO cutoff `windowDays` before `nowMs` — rows at/earlier than this are old
// enough to archive. Used to push the date filter into the SQL query so the
// sweep doesn't have to scan every candidate. Serves BOTH rules: pass it the
// done-window to filter completed_at, or the overdue-window to filter due_date.
export function archiveCutoffIso(nowMs: number, windowDays: number = ARCHIVE_AFTER_DAYS): string {
  return new Date(nowMs - windowDays * DAY_MS).toISOString();
}
