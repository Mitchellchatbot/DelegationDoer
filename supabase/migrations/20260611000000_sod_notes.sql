-- Start-of-day reports. Mirrors eod_notes: one row per user/date with
-- structured answers the user fills via the SOD typeform on their first
-- login of a new shift. Submitted rows trigger a Slack DM to leaders +
-- admins + Mujtaba (handled in /api/sod/submit).

create table if not exists sod_notes (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  -- Calendar date in the user's work timezone. SOD is anchored to a
  -- shift day, not wall-clock UTC, so the same user can never have two
  -- rows for the same local date.
  note_date date not null,
  -- "What's the top thing you want to get done today?" (single line)
  top_priority text,
  -- Free-form list of tasks the user plans to tackle. Stored as a
  -- single string with newline-separated lines so the form's "add as
  -- task" / "pick existing" affordances stay client-side and we don't
  -- need a join table just for the daily plan.
  tasks_planned text,
  -- "Anything blocking you?" — optional.
  blockers text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, note_date)
);

create index if not exists sod_notes_date_idx on sod_notes(note_date desc, user_id);
create index if not exists sod_notes_submitted_idx on sod_notes(submitted_at desc);
