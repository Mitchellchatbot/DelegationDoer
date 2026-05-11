-- Clock in / clock out. One row per shift segment. The "open" shift is
-- the row where ended_at IS NULL — guaranteed at most one per user via a
-- partial unique index.
create table if not exists time_entries (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Optional free-text note (e.g. "lunch ran long", "remote today").
  note text,
  created_at timestamptz not null default now()
);

create index if not exists time_entries_user_idx on time_entries(user_id, started_at desc);
-- A user can only have one open shift at a time. Partial unique index on
-- ended_at IS NULL enforces it cleanly.
create unique index if not exists time_entries_one_open_per_user
  on time_entries(user_id) where ended_at is null;
