-- Tracks which Google Calendar event id represents which celebrant's
-- birthday on which owner's calendar. Lets the sync helper PATCH or
-- DELETE the right event when a birthday changes, instead of
-- creating duplicates on every run.
create table if not exists birthday_calendar_events (
  id text primary key default gen_random_uuid()::text,
  owner_user_id text not null references users(id) on delete cascade,
  celebrant_user_id text not null references users(id) on delete cascade,
  google_event_id text not null,
  -- Snapshot the birthday we last synced so we can detect changes
  -- without re-fetching Google. Stored as MM-DD (year-agnostic) so
  -- a wrong-year birthday entered by accident doesn't trigger an
  -- update every sync.
  celebrant_month_day text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, celebrant_user_id)
);

create index if not exists birthday_cal_owner_idx
  on birthday_calendar_events (owner_user_id);
create index if not exists birthday_cal_celebrant_idx
  on birthday_calendar_events (celebrant_user_id);
