-- End-of-day reports to Slack.
--
-- Two pieces:
--   1. Each department gets an optional Slack channel id. When set, the
--      EOD report for that department is sent to that channel. Stored
--      as a channel ID (Cxxxx) rather than a name because Slack's
--      chat.postMessage requires the id form anyway.
--   2. Each user can write a free-form "what I did today" note per day.
--      Used in the EOD digest alongside the auto-aggregated completed
--      tasks + hours logged.

alter table departments
  add column if not exists slack_channel_id text;

create table if not exists eod_notes (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  -- Calendar date the note is for (user-local). Stored as a date,
  -- not timestamptz, because EOD is conceptually anchored to a day.
  note_date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, note_date)
);

create index if not exists eod_notes_date_idx on eod_notes(note_date desc, user_id);
