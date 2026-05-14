-- Team inbox spaces. A space groups one or more Missive accounts and
-- one or more users. Membership in a space grants visibility to every
-- account in it, on top of whatever per-account assignments already
-- exist. Lets the leader build "Tech Hub" (sean@, aly@, henry@) for
-- the engineers and "Marketing" for the marketers without manually
-- wiring N×M assignments.

create table if not exists public.inbox_spaces (
  id          text primary key,
  name        text not null,
  color       text not null default 'blue'
              check (color in ('blue','indigo','violet','fuchsia','pink','amber','emerald','teal','rose','sky')),
  created_at  timestamptz not null default now(),
  created_by  text references public.users(id) on delete set null
);

create table if not exists public.inbox_space_accounts (
  space_id   text not null references public.inbox_spaces(id) on delete cascade,
  account_id text not null,
  primary key (space_id, account_id)
);
create index if not exists inbox_space_accounts_account_idx
  on public.inbox_space_accounts (account_id);

create table if not exists public.inbox_space_members (
  space_id text not null references public.inbox_spaces(id) on delete cascade,
  user_id  text not null references public.users(id) on delete cascade,
  primary key (space_id, user_id)
);
create index if not exists inbox_space_members_user_idx
  on public.inbox_space_members (user_id);

alter table public.inbox_spaces        enable row level security;
alter table public.inbox_space_accounts enable row level security;
alter table public.inbox_space_members  enable row level security;
