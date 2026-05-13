-- Leader-only todo lists. Each leader gets their own private lists
-- (Today, Long-term, plus any custom ones they add) and there's also
-- a single workspace-wide "Shared" list both/all leaders can edit.
--
-- Lists with owner_id NULL are shared (visible + editable by every
-- leader). Lists with an owner_id are owned by that leader; other
-- leaders can see + edit them too (equal-authority model).

create table if not exists public.todo_lists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text references public.users(id) on delete cascade,
  title       text not null,
  kind        text not null default 'custom'
              check (kind in ('today', 'longterm', 'custom', 'shared')),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists todo_lists_owner_idx on public.todo_lists (owner_id);

create table if not exists public.todo_items (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.todo_lists(id) on delete cascade,
  content     text not null,
  done        boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  done_at     timestamptz,
  created_by  text references public.users(id) on delete set null
);

create index if not exists todo_items_list_idx on public.todo_items (list_id, position);

-- Auto-bump updated_at on parent list when items change so the
-- sidebar can show "most recently active" without scanning items.
create or replace function public.touch_todo_list_on_item_change()
returns trigger language plpgsql as $$
begin
  update public.todo_lists set updated_at = now()
   where id = coalesce(new.list_id, old.list_id);
  return coalesce(new, old);
end; $$;

drop trigger if exists todo_items_touch_list on public.todo_items;
create trigger todo_items_touch_list
  after insert or update or delete on public.todo_items
  for each row execute function public.touch_todo_list_on_item_change();

-- Seed one shared list for the workspace if there isn't one yet.
insert into public.todo_lists (owner_id, title, kind, position)
select null, 'Shared with leaders', 'shared', 0
where not exists (
  select 1 from public.todo_lists where kind = 'shared' and owner_id is null
);

alter table public.todo_lists enable row level security;
alter table public.todo_items enable row level security;
