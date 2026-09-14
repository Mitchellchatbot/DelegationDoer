-- Manually-maintained MRR list (owner's source of truth), seeded from the
-- Scaled AI MRR Mastersheet and editable in the finance dashboard.
create table if not exists mrr_entries (
  id text primary key,
  company text not null,
  mrr numeric not null default 0,
  status text not null default 'active', -- active | pending | paused | churned
  subscription_day text,
  satisfaction text,
  note text,
  rank int,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
