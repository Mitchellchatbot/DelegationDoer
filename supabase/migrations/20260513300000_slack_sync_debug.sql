-- Persist the last Slack-sync attempt so the user can see in the UI
-- whether the mirror is firing and what Slack said back. Without
-- this, the fire-and-forget sync swallows everything to the server
-- console — invisible to anyone debugging from the browser.

alter table public.users
  add column if not exists slack_last_sync_at  timestamptz,
  add column if not exists slack_last_sync_ok  boolean,
  add column if not exists slack_last_sync_msg text;
