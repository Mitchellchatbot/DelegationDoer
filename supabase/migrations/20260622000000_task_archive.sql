-- Task archiving — keep the active "Done" column clean by moving long-finished
-- tasks out of every live view while retaining them, in full, for later access.
--
-- Like soft-delete (20260620000000_task_soft_delete.sql) this is a non-
-- destructive UPDATE: an archived task keeps its title, status, assignee,
-- client, deadline, history, and completion date — it is NOT deleted. The
-- only difference from delete is intent and reach:
--   * archive_at  → hidden from the active board/mine/search lists but still
--                   shown on a dedicated "Archived" view and still counted in
--                   historical analytics (which read tasks directly).
--   * deleted_at  → hidden everywhere (admin recovery only).
-- A task can be archived then later deleted; delete takes precedence in views.

-- 1) completed_at — the canonical "when was this task finished" timestamp.
--    The schema had no completion time before this: the only signal was the
--    status_change activity_logs row or last_activity_at (which moves on any
--    edit). The archive rule ("done more than 7 days ago") needs a stable
--    completion instant, so we stamp it on the done transition (see the PATCH
--    route) and clear it when a task is reopened.
alter table public.tasks
  add column if not exists completed_at timestamptz;

-- 2) Archive stamps. archived_at non-null = archived. archived_by is the user
--    who archived it manually, or NULL when the daily cron auto-archived it
--    (mirrors deleted_by's nullable references public.users).
alter table public.tasks
  add column if not exists archived_at timestamptz;
alter table public.tasks
  add column if not exists archived_by text references public.users(id) on delete set null;

-- Partial index on the sparse archived flag — the hot path filters
-- `where archived_at is null` (active views) and the archived view filters
-- `where archived_at is not null`. The partial index serves the latter and
-- keeps the active-task scan cheap (mirrors tasks_deleted_at_idx).
create index if not exists tasks_archived_at_idx
  on public.tasks (archived_at)
  where archived_at is not null;

-- The archive cron scans for done tasks completed before a cutoff; an index
-- on completed_at for done rows keeps that scan cheap as history grows.
create index if not exists tasks_completed_at_idx
  on public.tasks (completed_at)
  where completed_at is not null;

-- 3) Backfill completed_at for tasks that are ALREADY done. Without this the
--    first cron run would see every historical done task as having no
--    completion time and skip it forever (it never crossed the done
--    transition while completed_at existed). last_activity_at is the best
--    available proxy for when these were finished — for a done task it's
--    almost always the done-transition timestamp.
update public.tasks
  set completed_at = last_activity_at
  where status = 'done'
    and completed_at is null;
