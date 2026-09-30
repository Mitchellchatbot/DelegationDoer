-- Per-key inputs for the Facebook September profit estimate (owner-only):
-- estimated ad spend, estimated operating expense, and any added expense lines.
-- Onboarding (Stripe one-offs tagged Facebook) and salaries (roster) are read
-- live, not stored here.
create table if not exists fb_estimate (
  key text primary key,
  value numeric not null default 0,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
