-- Client Hub: top-level "clients" replace the old projects-as-engagements
-- concept. Each client is a folder that holds three resource kinds:
-- meeting links, documents, and suggestions/notes.
--
-- Existing tasks already carry a free-text `client_name` column; we keep
-- that as the linkage for now (no FK migration) so legacy seeded tasks
-- continue to surface under their client. The seed below populates clients
-- from the distinct client_names already in the tasks table so the UI has
-- something to show day one.

create table if not exists public.clients (
  id          text primary key,
  name        text not null unique,
  website     text,
  priority    text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- All three resource kinds in one polymorphic table to avoid three nearly-
-- identical schemas. `kind` discriminator + `url` (for meeting/document) +
-- `body` (for suggestion) covers every case we have today.
create table if not exists public.client_resources (
  id          text primary key,
  client_id   text not null references public.clients(id) on delete cascade,
  kind        text not null check (kind in ('meeting', 'document', 'suggestion')),
  title       text not null,
  url         text,                                    -- nullable: suggestions don't need one
  body        text,                                    -- nullable: meetings/documents may not have body
  created_by  text references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists clients_priority_idx          on public.clients (priority);
create index if not exists client_resources_client_id_idx on public.client_resources (client_id);
create index if not exists client_resources_kind_idx      on public.client_resources (kind);

alter table public.clients          enable row level security;
alter table public.client_resources enable row level security;

create or replace function public.set_clients_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists clients_set_updated_at on public.clients;
create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.set_clients_updated_at();

-- Seed: every distinct non-null client_name in tasks becomes a client.
-- Uses lower-case kebab as id so they're stable across runs.
insert into public.clients (id, name, website)
select
  'cl_' || regexp_replace(lower(trim(t.client_name)), '[^a-z0-9]+', '_', 'g'),
  t.client_name,
  -- Pick the most-frequent website associated with that client_name, if any.
  (
    select t2.website
      from public.tasks t2
     where t2.client_name = t.client_name and t2.website is not null
     group by t2.website
     order by count(*) desc
     limit 1
  )
from (
  select distinct client_name from public.tasks where client_name is not null and client_name <> ''
) t
on conflict (id) do nothing;
