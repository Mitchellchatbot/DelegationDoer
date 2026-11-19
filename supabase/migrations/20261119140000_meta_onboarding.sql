-- Meta onboarding: the Meta Instant Form → Sheet → Zap → Scaled Sync +
-- Scaled Admissions setup for one client, worked on /meta-onboarding. The SOP
-- and its 32-box go-live checklist live in src/lib/meta-onboarding.ts.
--
-- Its OWN table, deliberately not keys inside fb_onboarding.state: ticking
-- here must never move a client's FB onboarding stage or clear its
-- completed_at. One row per Facebook task, the same anchor FB onboarding uses
-- (the task carries the assignee, due date and conversation).
--
-- `state` is a FLAT jsonb map of key -> { v, by, at }, the same shape as
-- fb_onboarding.state. The valid keys are defined in the TypeScript module and
-- the API rejects anything else, so the shape here stays deliberately loose.
--
-- Writes go through meta_onboarding_set(), which merges one key and
-- reconciles completed_at IN THE SAME TRANSACTION, off the state it just
-- stored: the row lock taken by the first UPDATE is held until the second, so
-- two people ticking at once can neither clobber each other's key nor leave
-- completed_at describing a state that no longer exists.
--
-- Security: RLS ON with NO policies, nothing granted to anon/authenticated,
-- and the function is SECURITY INVOKER with EXECUTE for service_role only.
-- Every caller is the server-side service-role client. (fb_onboarding_set was
-- created executable by PUBLIC and needed 20260923130000 to close that; this
-- one is born closed.)
--
-- Until this runs, /meta-onboarding says it is waiting for this migration and
-- nothing else in the app is affected.
--
-- Idempotent. Apply MANUALLY in the Supabase SQL editor. Merging the PR runs
-- nothing in this repo. The last statement is a check: read its one row.

create table if not exists public.meta_onboarding (
  task_id      text primary key references public.tasks(id) on delete cascade,
  state        jsonb not null default '{}'::jsonb,
  started_by   text references public.users(id) on delete set null,
  started_at   timestamptz not null default now(),
  -- Stamped when all 32 checklist boxes are ticked; cleared again if one is
  -- un-ticked afterwards. Kept when it is already set, so re-saving a
  -- finished client doesn't move its date.
  completed_at timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.meta_onboarding enable row level security;
revoke all on table public.meta_onboarding from anon, authenticated;

-- Merge one key, then reconcile completed_at against p_required (the
-- checklist keys, passed by the app so the list has one source of truth).
-- Returns no row when the onboarding hasn't been started.
create or replace function public.meta_onboarding_set(
  p_task_id  text,
  p_key      text,
  p_entry    jsonb,
  p_required text[]
)
returns table (state jsonb, completed_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_state    jsonb;
  v_complete boolean;
begin
  update public.meta_onboarding as m
     set state      = m.state || jsonb_build_object(p_key, p_entry),
         updated_at = now()
   where m.task_id = p_task_id
  returning m.state into v_state;

  if not found then
    return;
  end if;

  -- Every required key ticked. An empty or null list is never complete.
  select coalesce(bool_and(coalesce((v_state -> k -> 'v') = 'true'::jsonb, false)), false)
    into v_complete
    from unnest(p_required) as k;

  return query
  update public.meta_onboarding as m
     set completed_at = case when v_complete then coalesce(m.completed_at, now()) else null end
   where m.task_id = p_task_id
  returning m.state, m.completed_at;
end;
$$;

revoke all on function public.meta_onboarding_set(text, text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.meta_onboarding_set(text, text, jsonb, text[]) to service_role;

notify pgrst, 'reload schema';

-- The SQL editor swallows RAISE NOTICE, so check by selecting. Expect ONE row
-- reading exactly:
--   rls_enabled true | anon_can_read false | authenticated_can_read false |
--   anon_can_call false | authenticated_can_call false | service_role_can_call true
select
  c.relrowsecurity                                                                   as rls_enabled,
  has_table_privilege('anon', 'public.meta_onboarding', 'select')                    as anon_can_read,
  has_table_privilege('authenticated', 'public.meta_onboarding', 'select')           as authenticated_can_read,
  has_function_privilege('anon', 'public.meta_onboarding_set(text, text, jsonb, text[])', 'execute')          as anon_can_call,
  has_function_privilege('authenticated', 'public.meta_onboarding_set(text, text, jsonb, text[])', 'execute') as authenticated_can_call,
  has_function_privilege('service_role', 'public.meta_onboarding_set(text, text, jsonb, text[])', 'execute')  as service_role_can_call
from pg_class c
join pg_namespace ns on ns.oid = c.relnamespace
where ns.nspname = 'public' and c.relname = 'meta_onboarding';
