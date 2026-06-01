-- Task soft-delete + deletion audit.
--
-- Tasks created by mistake / duplicates / spam / mis-routed emails need a
-- way to be removed. We do this as a SOFT delete (an UPDATE stamping
-- deleted_at / deleted_by) rather than a hard row delete, because:
--   * it's consistent with the existing soft-delete philosophy in this
--     schema — status='rejected' already keeps denied drafts "for audit"
--     (see 20260609000000_routing_review.sql);
--   * a hard delete cascades activity_logs (ON DELETE CASCADE) and NULLs
--     email_intake_log.task_id / routing_decisions.task_id, destroying the
--     very audit trail we want to keep;
--   * soft-deleted tasks stay recoverable by admins and retained for history.
--
-- Email-originated tasks: a soft delete is a plain UPDATE, so it touches
-- NONE of the email links — email_intake_log keeps pointing at the task
-- (so the cron still treats the Missive thread as handled and won't
-- re-create it) and the original email in Missive is never affected.

alter table public.tasks
  add column if not exists deleted_at timestamptz;
alter table public.tasks
  add column if not exists deleted_by text references public.users(id) on delete set null;

-- Partial index on the sparse column — the hot path filters
-- `where deleted_at is null`, and the admin recovery view filters
-- `where deleted_at is not null`; the partial index serves the latter
-- and keeps the active-task scan cheap (mirrors tasks_is_draft_idx).
create index if not exists tasks_deleted_at_idx
  on public.tasks (deleted_at)
  where deleted_at is not null;

-- Dedicated, append-only audit of every task deletion. Richer than the
-- per-task activity_logs entry (which lives on the row and would be lost
-- on any future hard purge): captures the reason and a full jsonb snapshot
-- of the task at delete time. task_id uses ON DELETE SET NULL (not cascade)
-- so this audit row survives even if the task is later hard-purged — the
-- snapshot preserves the name/id for accountability either way.
create table if not exists public.task_deletions (
  id text primary key,
  task_id text references public.tasks(id) on delete set null,
  task_title text not null,
  deleted_by text references public.users(id) on delete set null,
  reason text,
  task_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists task_deletions_created_at_idx
  on public.task_deletions (created_at desc);

alter table public.task_deletions enable row level security;
