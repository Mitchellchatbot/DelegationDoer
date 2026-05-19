-- Per-user client updates logged as part of the daily EOD form.
-- The Website team (dep_web) — and eventually SEO too — uses these
-- to track per-client touches that get posted to Slack on save, so
-- the worker fills in "I emailed Acme about X" and the team sees
-- the touch land in the shared channel immediately.
--
-- One row per update; a worker can log multiple per day (the EOD
-- form has an "+ Add another" button). The `slack_ts` + `slack_channel`
-- columns capture the post receipt so we can later edit/delete the
-- Slack message if the user retracts the update.

create table if not exists eod_client_updates (
  id           text primary key,
  user_id      text not null references public.users(id) on delete cascade,
  -- Calendar date the update is filed against, in the worker's local
  -- timezone — same convention as eod_notes.
  note_date    date not null,
  -- FK to clients table; nullable so an update doesn't disappear if
  -- the client row is later deleted (we keep client_name as a copy
  -- for posterity).
  client_id    text references public.clients(id) on delete set null,
  client_name  text not null,
  message      text not null,
  -- Slack receipt fields — populated when the post lands. Null means
  -- the row was saved but Slack didn't accept (or wasn't configured).
  slack_ts     text,
  slack_channel text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists eod_client_updates_user_date_idx
  on eod_client_updates(user_id, note_date desc);

-- Powers the weekly counter on /dashboard: "X client updates this week."
-- sent_at is what the counter cares about (not created_at), so a draft
-- that never went to Slack doesn't pad the number.
create index if not exists eod_client_updates_sent_at_idx
  on eod_client_updates(user_id, sent_at desc);
