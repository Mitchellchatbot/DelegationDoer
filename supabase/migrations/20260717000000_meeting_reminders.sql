-- Per-user, per-event dedup for the widget "client meeting in ~30 min"
-- reminder. The Electron widget polls /api/widget/meeting-reminder every
-- ~15s; that route records each meeting it surfaces here so the same
-- meeting fires exactly once (PK on user_id+event_id), surviving the 15s
-- re-poll and widget restarts within the 30-min window.
--
-- event_id is the Google Calendar event id. With singleEvents=true a
-- recurring weekly call expands to a unique instance id per occurrence,
-- so each week's meeting reminds independently.

create table if not exists public.meeting_reminders (
  user_id     text not null references public.users(id) on delete cascade,
  event_id    text not null,
  client_id   text,
  notified_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

-- Supports an optional periodic cleanup of stale rows
-- (delete where notified_at < now() - interval '14 days').
create index if not exists meeting_reminders_notified_at_idx
  on public.meeting_reminders (notified_at);
