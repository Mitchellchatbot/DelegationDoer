-- Employee of the Month. One row per calendar month (YYYY-MM key).
-- The CEO can re-crown by upserting; previous holder for the same month
-- is overwritten.
create table if not exists employee_of_month (
  month text primary key,                        -- e.g. "2026-05"
  user_id text not null references users(id) on delete cascade,
  crowned_by_id text references users(id) on delete set null,
  crowned_at timestamptz not null default now(),
  reason text
);

create index if not exists employee_of_month_user_idx on employee_of_month(user_id);
