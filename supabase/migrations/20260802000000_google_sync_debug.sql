-- Persist the last Google-token-refresh attempt so the user can see in
-- the UI whether the calendar connection is still alive and, when it
-- breaks, exactly what Google said back (usually invalid_grant). Without
-- this the lazy refresh in lib/google-calendar.ts swallows the failure
-- to the Railway console — invisible to anyone debugging from the
-- browser, and it hides the tell-tale ~7-day connect->break delta that
-- points at a Testing-mode / pre-publish refresh token. Mirrors the
-- slack_last_sync_* columns from 20260513300000_slack_sync_debug.sql.

alter table public.users
  add column if not exists google_last_sync_at  timestamptz,
  add column if not exists google_last_sync_ok  boolean,
  add column if not exists google_last_sync_msg text;
