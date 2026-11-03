-- EMERGENCY ROLLBACK for supabase/migrations/20261104000000_p0_lock_down_anon_access.sql
--
-- This RE-OPENS the exposure that migration closed (anon-key access to users,
-- scheduled_emails, ...). Use it only if something real broke after the
-- lockdown and you need the old behaviour back while you fix it — then
-- re-apply the migration.
--
-- It restores, from the p0_acl_backup snapshot the migration took on its
-- first run:
--   * the table/view/sequence privileges PUBLIC, anon and authenticated held
--     (table-level; column-only grants are not snapshotted),
--   * RLS OFF on the tables that had it off,
--   * the anon/authenticated/PUBLIC policies that were dropped (including the
--     storage listing policy),
--   * the routine EXECUTE grants to PUBLIC/anon/authenticated,
--   * the per-schema default privileges of `postgres` on `public`, exactly as
--     saved.
--
-- Apply MANUALLY in the Supabase SQL editor. One transaction: an error
-- changes nothing.

set local lock_timeout = '5s';
set local search_path = '';

do $$
begin
  if pg_catalog.to_regclass('p0_acl_backup.relations') is null then
    raise exception 'p0_acl_backup not found — the lockdown migration never ran here, nothing to roll back';
  end if;
end $$;

-- 1. Table / view / sequence privileges for PUBLIC, anon and authenticated.
do $$
declare
  r record;
begin
  for r in
    select b.relname, b.relkind, a.privilege_type,
           case when a.grantee = 0 then 'public' else pg_catalog.quote_ident(a.grantee::regrole::text) end as grantee
    from p0_acl_backup.relations b
    cross join lateral pg_catalog.aclexplode(b.relacl::aclitem[]) a
    where (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole))
      and pg_catalog.to_regclass(pg_catalog.format('public.%I', b.relname)) is not null
  loop
    execute pg_catalog.format(
      'grant %s on %s public.%I to %s',
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
    join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', b.relname))
    where b.relkind in ('r', 'p') and not b.rls_enabled and c.relrowsecurity
  loop
    execute pg_catalog.format('alter table public.%I disable row level security', r.relname);
  end loop;
end $$;

-- 3. Recreate the dropped policies (public tables + the storage one).
do $$
declare
  r record;
  role_list text;
begin
  for r in
    select b.*
    from p0_acl_backup.policies b
    where pg_catalog.to_regclass(pg_catalog.format('%I.%I', b.schemaname, b.tablename)) is not null
      and not exists (
            select 1 from pg_catalog.pg_policies p
            where p.schemaname = b.schemaname and p.tablename = b.tablename and p.policyname = b.policyname)
  loop
    select pg_catalog.string_agg(case when x = 'public' then 'public' else pg_catalog.quote_ident(x) end, ', ')
      into role_list
    from pg_catalog.unnest(r.roles) as x;

    execute pg_catalog.format(
      'create policy %I on %I.%I as %s for %s to %s%s%s',
      r.policyname,
      r.schemaname,
      r.tablename,
      r.permissive,
      r.cmd,
      role_list,
      case when r.qual is not null then ' using (' || r.qual || ')' else '' end,
      case when r.with_check is not null then ' with check (' || r.with_check || ')' else '' end
    );
  end loop;
end $$;

-- 4. Routine EXECUTE for PUBLIC / anon / authenticated. Signatures were saved
--    fully qualified, so a routine that no longer exists is simply skipped.
do $$
declare
  r record;
begin
  for r in
    select b.signature,
           case when a.grantee = 0 then 'public' else pg_catalog.quote_ident(a.grantee::regrole::text) end as grantee
    from p0_acl_backup.functions b
    cross join lateral pg_catalog.aclexplode(
      coalesce(b.proacl::aclitem[], pg_catalog.acldefault('f', b.owner_name::regrole))
    ) a
    where a.privilege_type = 'EXECUTE'
      and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole))
      and pg_catalog.to_regprocedure(b.signature) is not null
  loop
    execute pg_catalog.format('grant execute on routine %s to %s', r.signature, r.grantee);
  end loop;
end $$;

-- 5. Default privileges: restore the saved anon/authenticated/PUBLIC entries
--    of the per-schema (postgres, public) rows.
do $$
declare
  r record;
begin
  for r in
    select case d.objtype when 'r' then 'tables' when 'S' then 'sequences'
                          when 'f' then 'functions' when 'T' then 'types' else null end as objects,
           a.privilege_type,
           case when a.grantee = 0 then 'public' else pg_catalog.quote_ident(a.grantee::regrole::text) end as grantee
    from p0_acl_backup.default_acls d
    cross join lateral pg_catalog.aclexplode(d.defaclacl::aclitem[]) a
    where (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole))
  loop
    if r.objects is not null then
      execute pg_catalog.format(
        'alter default privileges for role postgres in schema public grant %s on %s to %s',
        r.privilege_type, r.objects, r.grantee);
    end if;
  end loop;
end $$;

-- Result grid: what is open again.
select
  (select pg_catalog.count(*) from pg_catalog.pg_policies
     where schemaname = 'public'
       and roles operator(pg_catalog.&&) array['anon', 'authenticated', 'public']::name[]) as open_public_policies_now,
  (select pg_catalog.count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity)          as tables_without_rls_now,
  (select pg_catalog.count(*) from p0_acl_backup.policies)                                       as policies_in_backup;
