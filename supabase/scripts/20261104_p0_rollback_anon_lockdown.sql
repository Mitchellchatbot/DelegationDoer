-- EMERGENCY ROLLBACK for supabase/migrations/20261104000000_p0_lock_down_anon_access.sql
--
-- This RE-OPENS the exposure that migration closed (anon-key access to users,
-- scheduled_emails, ...). Use it only if something real broke after the
-- lockdown and you need the old behaviour back while you fix it — then
-- re-apply the migration.
--
-- It restores, from the p0_acl_backup snapshot the migration took on its
-- first run:
--   * the table/view/sequence privileges anon and authenticated held,
--   * RLS OFF on the tables that had it off,
--   * the anon/authenticated/PUBLIC policies that were dropped,
--   * the function EXECUTE grants to PUBLIC/anon/authenticated,
--   * Supabase's default privileges for objects created later.
--
-- Apply MANUALLY in the Supabase SQL editor. One transaction: an error
-- changes nothing.

do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'p0_acl_backup') then
    raise exception 'p0_acl_backup schema not found — the lockdown migration never ran here, nothing to roll back';
  end if;
end $$;

-- 1. Table / view / sequence privileges for anon and authenticated.
do $$
declare
  r record;
begin
  for r in
    select b.relname, b.relkind, a.privilege_type, a.grantee::regrole::text as grantee
    from p0_acl_backup.relations b
    cross join lateral aclexplode(b.relacl) a
    where a.grantee in ('anon'::regrole, 'authenticated'::regrole)
      and exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = b.relname
      )
  loop
    execute format(
      'grant %s on %s public.%I to %I',
      r.privilege_type,
      case when r.relkind = 'S' then 'sequence' else 'table' end,
      r.relname,
      r.grantee
    );
  end loop;
end $$;

-- 2. RLS back OFF where it was off.
do $$
declare
  r record;
begin
  for r in
    select b.relname
    from p0_acl_backup.relations b
    join pg_class c on c.relname = b.relname
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where b.relkind in ('r', 'p') and not b.rls_enabled and c.relrowsecurity
  loop
    execute format('alter table public.%I disable row level security', r.relname);
  end loop;
end $$;

-- 3. Recreate the dropped policies.
do $$
declare
  r record;
  role_list text;
begin
  for r in
    select b.*
    from p0_acl_backup.policies b
    where exists (
            select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = b.tablename)
      and not exists (
            select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = b.tablename and p.policyname = b.policyname)
  loop
    select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ')
      into role_list
    from unnest(r.roles) as x;

    execute format(
      'create policy %I on public.%I as %s for %s to %s%s%s',
      r.policyname,
      r.tablename,
      r.permissive,
      r.cmd,
      role_list,
      case when r.qual is not null then ' using (' || r.qual || ')' else '' end,
      case when r.with_check is not null then ' with check (' || r.with_check || ')' else '' end
    );
  end loop;
end $$;

-- 4. Function EXECUTE for PUBLIC / anon / authenticated.
do $$
declare
  r record;
begin
  for r in
    select b.signature,
           case when a.grantee = 0 then 'public' else quote_ident(a.grantee::regrole::text) end as grantee
    from p0_acl_backup.functions b
    cross join lateral aclexplode(coalesce(b.proacl, acldefault('f', b.owner_oid))) a
    where a.privilege_type = 'EXECUTE'
      and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole))
      and to_regprocedure(b.signature) is not null
  loop
    execute format('grant execute on routine %s to %s', r.signature, r.grantee);
  end loop;
end $$;

-- 5. Supabase's default privileges for objects created later.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to public, anon, authenticated;

-- Result grid: what was restored.
select
  (select count(*) from pg_policies
     where schemaname = 'public' and roles && array['anon', 'authenticated', 'public']::name[]) as open_policies_now,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity)            as tables_without_rls_now,
  (select count(*) from p0_acl_backup.policies)                                                     as policies_in_backup;
