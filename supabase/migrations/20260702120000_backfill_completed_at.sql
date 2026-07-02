-- Backfill completed_at for done tasks left null by write paths that omitted
-- it (clients-import CSV, seed-eod) after the 2026-06-22 task_archive backfill.
-- The completion counters (leaderboard, EOD digest, analytics, team views) now
-- key off completed_at, so a null value silently drops the task from those
-- counts. Idempotent; safe to re-run. last_activity_at is the best available
-- proxy for the recorded completion time on these historical rows, matching the
-- original backfill in 20260622000000_task_archive.sql.
update public.tasks
   set completed_at = last_activity_at
 where status = 'done'
   and completed_at is null;
