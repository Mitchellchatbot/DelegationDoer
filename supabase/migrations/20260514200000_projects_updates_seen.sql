-- Per-user "last time I looked at the Projects updates tab" marker.
-- Used to compute the unread-badge count: any project task whose
-- last_activity_at is more recent than this is "new since you
-- last checked". Null = never checked, so all activity is unseen
-- on first load.

alter table public.users
  add column if not exists projects_updates_seen_at timestamptz;
