-- Per-user Slack connection. Stores the user's own xoxp- token so we
-- can call users.profile.set on their behalf when the widget changes
-- their presence/emoji — Slack rejects cross-user profile writes
-- from bot tokens, so every employee who wants the mirror has to
-- click "Connect Slack" once.
--
-- Token is stored plain — fine for now since the DB is private. If we
-- ever expose row-level reads via PostgREST we'll move to pgcrypto.

alter table public.users
  add column if not exists slack_user_id text,
  add column if not exists slack_team_id text,
  add column if not exists slack_user_token text,
  add column if not exists slack_connected_at timestamptz;

create index if not exists users_slack_user_id_idx on public.users (slack_user_id);
