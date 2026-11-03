-- READ-ONLY exposure check. Safe to run in the Supabase SQL editor at any time.
--
-- Lists what the browser-shipped anon key (role `anon`) or any signed-in
-- user's JWT (role `authenticated`) can reach in every schema those roles can
-- USE (public, and anything else that has been granted — e.g. a mistakenly
-- exposed `missive`):
--
--   * tables/views with row-level security OFF where those roles hold a
--     table or column privilege -> every row is readable (and, with
--     INSERT/UPDATE/DELETE, writable) by anyone who has the anon key,
--   * tables with RLS ON but a policy granting those roles access,
--   * routines in `public` those roles can EXECUTE (SECURITY DEFINER ones run
--     with the owner's rights and bypass RLS),
--   * extensions installed into `public` (their functions are excluded from
--     the routine list, so check that none of them is risky: http, pg_net...).
--
-- Whether a schema is actually served over HTTP depends on the project's
-- "Exposed schemas" API setting — this grid shows what WOULD be reachable.
-- Supabase's own schemas (auth, storage, realtime, ...) show up only when a
-- policy there lets these roles in.
--
-- Run it BEFORE applying 20261104000000_p0_lock_down_anon_access.sql (save
-- the grid) and AFTER: `public` rows should be gone; anything left needs a
-- look. One result grid, most severe first.

with rel as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\_%'
    and (has_schema_privilege('anon', n.oid, 'USAGE') or has_schema_privilege('authenticated', n.oid, 'USAGE'))
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
),
pol as (
  select schemaname, tablename,
         string_agg(policyname || ' [' || cmd || ' to ' || array_to_string(roles, ',') || ']', '; ') as open_policies
  from pg_policies
  where roles && array['anon', 'authenticated', 'public']::name[]
  group by schemaname, tablename
),
rel_privs as (
  select r.nspname, r.relname, r.relkind, r.relrowsecurity,
         array_remove(array[
           case when has_table_privilege('anon', r.oid, 'SELECT') then 'SELECT' end,
           case when has_table_privilege('anon', r.oid, 'INSERT') then 'INSERT' end,
           case when has_table_privilege('anon', r.oid, 'UPDATE') then 'UPDATE' end,
           case when has_table_privilege('anon', r.oid, 'DELETE') then 'DELETE' end,
           case when has_table_privilege('anon', r.oid, 'TRUNCATE') then 'TRUNCATE' end,
           case when not has_table_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE')
                     and has_any_column_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE') then 'COLUMN GRANT' end
         ], null) as anon_privs,
         array_remove(array[
           case when has_table_privilege('authenticated', r.oid, 'SELECT') then 'SELECT' end,
           case when has_table_privilege('authenticated', r.oid, 'INSERT') then 'INSERT' end,
           case when has_table_privilege('authenticated', r.oid, 'UPDATE') then 'UPDATE' end,
           case when has_table_privilege('authenticated', r.oid, 'DELETE') then 'DELETE' end,
           case when has_table_privilege('authenticated', r.oid, 'TRUNCATE') then 'TRUNCATE' end,
           case when not has_table_privilege('authenticated', r.oid, 'SELECT, INSERT, UPDATE')
                     and has_any_column_privilege('authenticated', r.oid, 'SELECT, INSERT, UPDATE') then 'COLUMN GRANT' end
         ], null) as authenticated_privs,
         p.open_policies
  from rel r
  left join pol p on p.schemaname = r.nspname and p.tablename = r.relname
),
findings as (
  select
    case
      when relkind in ('r', 'p', 'f') and not relrowsecurity then 1
      when relkind in ('v', 'm') then 2
      else 3
    end as severity,
    case
      when relkind in ('r', 'p', 'f') and not relrowsecurity
        then 'OPEN: no RLS, every row reachable with these privileges'
      when relkind in ('v', 'm')
        then 'VIEW: reachable with these privileges (views run as their owner)'
      else 'POLICY: RLS on, but a policy lets these roles in'
    end as exposure,
    case relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end as object_kind,
    nspname || '.' || relname as object_name,
    array_to_string(anon_privs, ',') as anon,
    array_to_string(authenticated_privs, ',') as authenticated,
    open_policies
  from rel_privs
  where (array_length(anon_privs, 1) > 0 or array_length(authenticated_privs, 1) > 0)
    and (
      (relkind in ('r', 'p', 'f') and not relrowsecurity)
      or relkind in ('v', 'm')
      or open_policies is not null
    )

  union all

  select
    case when p.prosecdef then 1 else 4 end,
    case when p.prosecdef
      then 'ROUTINE: SECURITY DEFINER, callable by these roles (bypasses RLS)'
      else 'ROUTINE: callable by these roles (runs with the caller''s rights)'
    end,
    case p.prokind when 'a' then 'aggregate' when 'w' then 'window function' when 'p' then 'procedure' else 'function' end,
    p.oid::regprocedure::text,
    case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'EXECUTE' else '' end,
    case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'EXECUTE' else '' end,
    null
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype <> 'trigger'::regtype
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'))

  union all

  select 5, 'INFO: extension installed in public (its functions are not listed above)',
         'extension', e.extname || ' ' || e.extversion, '', '', null
  from pg_extension e
  where e.extnamespace = 'public'::regnamespace
)
select severity, exposure, object_kind, object_name, anon, authenticated, open_policies
from findings
order by severity, object_name;
