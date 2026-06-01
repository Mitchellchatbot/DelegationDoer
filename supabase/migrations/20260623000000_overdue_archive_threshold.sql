-- Configurable overdue auto-archive threshold.
--
-- The archive sweep (src/lib/task-archive-runner.ts) already removes finished
-- work from the active board: tasks done more than ARCHIVE_AFTER_DAYS (7) days
-- ago. This adds the second rule from the spec — open tasks that are overdue by
-- more than N days are stale/abandoned and should drop off the board too.
--
-- N lives on the workspace_settings singleton (mirrors low_site_score_threshold
-- added in 20260621000000) so it's editable from Settings without a code change.
-- Default 10 matches the spec's example. The done-window (7 days) stays a code
-- constant for now — only the overdue threshold was called out as configurable.
alter table public.workspace_settings
  add column if not exists overdue_archive_days integer not null default 10;
