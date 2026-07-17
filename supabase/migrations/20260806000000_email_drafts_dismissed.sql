-- Recoverable "archive" for email_drafts.
--
-- Orthogonal to `status`: a draft can stay 'pending' but be hidden from
-- the /approvals Emails queue when dismissed_at is set. This backs the
-- Emails tab's new Auto-replies sub-section, where an approver can clear
-- the auto_reply (kind='auto_reply') pile-up in bulk WITHOUT touching the
-- status lifecycle, its check constraint, or firing any Slack pings.
-- Restore = set dismissed_at back to null.
alter table public.email_drafts add column if not exists dismissed_at timestamptz;
alter table public.email_drafts add column if not exists dismissed_by text;

-- Partial index for the "Show archived" view (dismissed rows of a given
-- kind/status). Only indexes dismissed rows, so it stays cheap.
create index if not exists email_drafts_dismissed_idx
  on public.email_drafts (kind, status)
  where dismissed_at is not null;
