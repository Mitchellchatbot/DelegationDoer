-- Self-extend a ticket's deadline. Tracked as discrete events so a manager
-- (dept head / CEO) can see how many times and by how long a ticket has slipped.

create table public.ticket_extensions (
  id                text primary key,
  ticket_id         text not null references public.tickets(id) on delete cascade,
  user_id           text not null references public.users(id),
  previous_due_date timestamptz,
  new_due_date      timestamptz not null,
  hours_added       numeric(7,2) not null,
  reason            text,
  created_at        timestamptz not null default now()
);

create index on public.ticket_extensions (ticket_id);
create index on public.ticket_extensions (user_id);

alter table public.ticket_extensions enable row level security;

-- Same permissive read policy as the rest of the schema. Tighten when auth lands.
create policy "read_all" on public.ticket_extensions for select to anon, authenticated using (true);
