-- READ-ONLY exposure check. Safe to run in the Supabase SQL editor at any time.
--
-- Lists everything in the `public` schema that the browser-shipped anon key
-- (role `anon`) or any signed-in user's JWT (role `authenticated`) can reach
-- through PostgREST / pg_graphql:
--
--   * tables/views with row-level security OFF where those roles hold a
--     privilege  -> every row is readable (and, with INSERT/UPDATE/DELETE,
--     writable) by anyone who has the anon key,
--   * tables with RLS ON but a policy granting those roles access,
--   * functions those roles can EXECUTE (SECURITY DEFINER ones run with the
--     owner's rights and bypass RLS entirely).
--
-- Run it BEFORE applying 20261104000000_p0_lock_down_anon_access.sql (to see
-- what was exposed — save the grid) and AFTER (it should return ZERO rows).
--
-- One result grid, most severe first.

with rel as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
    )
),
pol as (
  select tablename,
         string_agg(policyname || ' [' || cmd || ' to ' || array_to_string(roles, ',') || ']', '; ') as open_policies
  from pg_policies
  where schemaname = 'public'
    and roles && array['anon', 'authenticated', 'public']::name[]
  group by tablename
),
rel_privs as (
  select r.relname,
         r.relkind,
         r.relrowsecurity,
         array_remove(array[
           case when has_table_privilege('anon', r.oid, 'SELECT') then 'SELECT' end,
           case when has_table_privilege('anon', r.oid, 'INSERT') then 'INSERT' end,
           case when has_table_privilege('anon', r.oid, 'UPDATE') then 'UPDATE' end,
           case when has_table_privilege('anon', r.oid, 'DELETE') then 'DELETE' end,
           case when has_table_privilege('anon', r.oid, 'TRUNCATE') then 'TRUNCATE' end
         ], null) as anon_privs,
         array_remove(array[
           case when has_table_privilege('authenticated', r.oid, 'SELECT') then 'SELECT' end,
           case when has_table_privilege('authenticated', r.oid, 'INSERT') then 'INSERT' end,
           case when has_table_privilege('authenticated', r.oid, 'UPDATE') then 'UPDATE' end,
           case when has_table_privilege('authenticated', r.oid, 'DELETE') then 'DELETE' end,
           case when has_table_privilege('authenticated', r.oid, 'TRUNCATE') then 'TRUNCATE' end
         ], null) as authenticated_privs,
         p.open_policies
  from rel r
  left join pol p on p.tablename = r.relname
),
findings as (
  select
    case
      when relkind in ('r', 'p', 'f') and not relrowsecurity
           and (array_length(anon_privs, 1) > 0 or array_length(authenticated_privs, 1) > 0)
        then 1
      when relkind in ('v', 'm')
           and (array_length(anon_privs, 1) > 0 or array_length(authenticated_privs, 1) > 0)
        then 2
      else 3
    end as severity,
    case
      when relkind in ('r', 'p', 'f') and not relrowsecurity
           and (array_length(anon_privs, 1) > 0 or array_length(authenticated_privs, 1) > 0)
        then 'OPEN: no RLS, every row reachable with these privileges'
      when relkind in ('v', 'm')
        then 'VIEW: reachable with these privileges (views run as their owner)'
      else 'POLICY: RLS on, but a policy lets these roles in'
    end as exposure,
    case relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end as object_kind,
    relname::text as object_name,
    array_to_string(anon_privs, ',') as anon,
    array_to_string(authenticated_privs, ',') as authenticated,
    open_policies
  from rel_privs
  where (relkind in ('r', 'p', 'f') and not relrowsecurity
           and (array_length(anon_privs, 1) > 0 or array_length(authenticated_privs, 1) > 0))
     or (relkind in ('v', 'm')
           and (array_length(anon_privs, 1) > 0 or array_length(authenticated_privs, 1) > 0))
     or (open_policies is not null
           and (array_length(anon_privs, 1) > 0 or array_length(authenticated_privs, 1) > 0))

  union all

  select
    case when p.prosecdef then 1 else 4 end as severity,
    case when p.prosecdef
      then 'FUNCTION: SECURITY DEFINER, callable by these roles (bypasses RLS)'
      else 'FUNCTION: callable by these roles (runs with the caller''s rights)'
    end as exposure,
    'function' as object_kind,
    p.oid::regprocedure::text as object_name,
    case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'EXECUTE' else '' end as anon,
    case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'EXECUTE' else '' end as authenticated,
    null as open_policies
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and p.prorettype <> 'trigger'::regtype
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    )
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
)
select severity, exposure, object_kind, object_name, anon, authenticated, open_policies
from findings
order by severity, object_name;
