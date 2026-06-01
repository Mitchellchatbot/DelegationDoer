// Archive policy — the single source of truth for "should this finished task
// drop off the active board?" Kept as a pure, side-effect-free function so the
// daily cron, the dry-run preview, and the standalone check script
// (scripts/check-archive.mjs) all agree on the rule.

// How long a task may sit in the active "Done" column before it auto-archives.
export const ARCHIVE_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

// Minimal shape the rule needs — accepts a full Task or a raw DB row.
export interface ArchivableTask {
  status: string;
  completedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

// True when a task is eligible for AUTO archiving: it's done, has a known
// completion time more than `windowDays` ago, and isn't already archived or
// deleted. `nowMs` is injected so the function stays deterministic/testable.
export function shouldAutoArchive(
  task: ArchivableTask,
  nowMs: number,
  windowDays: number = ARCHIVE_AFTER_DAYS
): boolean {
  if (task.status !== "done") return false;     // only finished work archives
  if (task.archivedAt) return false;            // already archived
  if (task.deletedAt) return false;             // deleted wins; leave it alone
  if (!task.completedAt) return false;          // no completion date → can't age it
  const completedMs = new Date(task.completedAt).getTime();
  if (Number.isNaN(completedMs)) return false;  // unparseable → skip, don't guess
  return nowMs - completedMs >= windowDays * DAY_MS;
}

// ISO cutoff `windowDays` before `nowMs` — tasks completed at/earlier than
// this are old enough to archive. Used to push the date filter into the SQL
// query so the cron doesn't have to scan every done task.
export function archiveCutoffIso(nowMs: number, windowDays: number = ARCHIVE_AFTER_DAYS): string {
  return new Date(nowMs - windowDays * DAY_MS).toISOString();
}
