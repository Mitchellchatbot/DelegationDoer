-- Adds optional scheduled_for to email_drafts. When set, the approve
-- endpoint leaves the draft at status='approved' instead of sending
-- immediately; the existing scheduled-emails cron picks up due
-- approved drafts and dispatches them via composeNewThread.
alter table public.email_drafts
  add column if not exists scheduled_for timestamptz;

create index if not exists email_drafts_due_idx
  on public.email_drafts (status, scheduled_for)
  where scheduled_for is not null;
