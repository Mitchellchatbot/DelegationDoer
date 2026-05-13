-- Per-user Google connection. Same shape as the Slack columns:
-- store the user's own OAuth tokens so we can read + write their
-- calendar on their behalf. Each employee clicks "Connect Google"
-- once and we mint a refresh token good for ~6 months.
--
-- Why refresh + access split: Google access tokens expire after ~60
-- minutes. The refresh token lives long, and we use it server-side to
-- mint fresh access tokens on demand. Both stored plain — same trust
-- model as the slack_user_token. Move to pgcrypto if we ever expose
-- row reads via PostgREST.

alter table public.users
  add column if not exists google_user_id      text,
  add column if not exists google_email        text,
  add column if not exists google_access_token text,
  add column if not exists google_refresh_token text,
  add column if not exists google_token_expiry timestamptz,
  add column if not exists google_connected_at timestamptz;

create index if not exists users_google_user_id_idx on public.users (google_user_id);
