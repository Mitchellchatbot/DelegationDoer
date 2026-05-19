-- Mandatory end-of-day per-client status check-ins for the Website
-- team. Distinct from eod_client_updates (the ad-hoc "I emailed Acme
-- about X" touch log) — this table backs the form a worker must fill
-- before their workday ends, summarizing each client's status. The
-- desktop widget pings when the worker's schedule.end time arrives
-- and no row has been filed for today.
--
-- Same row-per-update shape as eod_client_updates so the API + UI can
-- reuse the same patterns. Posts to the same Slack channel
-- (scaled_team_channel_id) but with a different prefix so the team
-- can tell touch-logs apart from end-of-day status check-ins.

create table if not exists eod_client_checkins (
  id           text primary key,
  user_id      text not null references public.users(id) on delete cascade,
  -- Calendar date the check-in is filed against (worker's local TZ).
  note_date    date not null,
  client_id    text references public.clients(id) on delete set null,
  client_name  text not null,
  message      text not null,
  -- Slack receipt fields — populated when the post lands.
  slack_ts     text,
  slack_channel text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists eod_client_checkins_user_date_idx
  on eod_client_checkins(user_id, note_date desc);

-- Powers the weekly counter + the widget's "have I filed today?" check.
create index if not exists eod_client_checkins_sent_at_idx
  on eod_client_checkins(user_id, sent_at desc);
