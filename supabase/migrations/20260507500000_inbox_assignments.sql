-- Inbox assignments: which DelegationDoer users have access to which
-- Missive email accounts. Source of truth for the role-based visibility
-- gate (CEO sees all, dept head sees their team's, worker sees own).
--
-- The Missive clone owns the actual email_accounts table on its own
-- Postgres; we mirror just the id + display fields we need for the UI so
-- a typo in the integration doesn't break role checks. The Missive id is
-- a uuid in their schema — we accept it as text here for simplicity.

create table if not exists public.inbox_assignments (
  id                  text primary key,
  user_id             text not null references public.users(id) on delete cascade,
  missive_account_id  text not null,
  inbox_email         text not null,
  inbox_label         text,
  assigned_by         text references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (user_id, missive_account_id)
);

create index if not exists inbox_assignments_user_id_idx on public.inbox_assignments (user_id);
create index if not exists inbox_assignments_account_id_idx on public.inbox_assignments (missive_account_id);

alter table public.inbox_assignments enable row level security;
