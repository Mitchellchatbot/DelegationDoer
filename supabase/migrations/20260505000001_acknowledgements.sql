-- Acknowledgements + RLS policies.
-- An assignee must explicitly tap ✓ on each ticket assigned to them; until
-- they do, the widget yells at them with a speech bubble + sound.

create table public.assignment_acknowledgements (
  user_id         text not null references public.users(id)  on delete cascade,
  ticket_id       text not null references public.tickets(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, ticket_id)
);
create index on public.assignment_acknowledgements (user_id);

alter table public.assignment_acknowledgements enable row level security;

-- Backfill: every (assignee, ticket) pair that already exists is treated as
-- already-acked, so the widget doesn't fire 13 alarms on first load.
insert into public.assignment_acknowledgements (user_id, ticket_id, acknowledged_at)
select assignee_id, id, coalesce(created_at, now())
from public.tickets
where assignee_id is not null
on conflict do nothing;

-- =========================================================================
-- RLS POLICIES
-- =========================================================================
-- Internal-tool defaults:
--   * service_role bypasses RLS and can do everything (used by the Next.js
--     server routes for AI + widget polling).
--   * anon and authenticated can read everything (no auth wired yet — when
--     it is, tighten anon down or off).
--   * Inserts/updates/deletes are server-only (service_role) for now.

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename in (
        'departments','users','department_members','skill_profiles',
        'projects','milestones','raci_entries','tickets','activity_logs',
        'incident_logs','incident_routing','assignment_acknowledgements'
      )
  loop
    execute format(
      'create policy "read_all" on public.%I for select to anon, authenticated using (true);',
      t
    );
  end loop;
end $$;
