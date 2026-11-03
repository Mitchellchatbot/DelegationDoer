-- P0.1 — lock the `public` schema away from the anon key and from end-user JWTs.
--
-- WHAT WAS WRONG
--
-- PostgREST exposes the `public` schema to two roles that the app never uses
-- for data: `anon` (the NEXT_PUBLIC_SUPABASE_ANON_KEY that ships in every
-- browser bundle) and `authenticated` (any signed-in user's JWT). Supabase
-- grants both roles every privilege on new tables, sequences and functions by
-- default, so whatever RLS does not stop is reachable:
--
--   * 20260505000001 created `read_all ... to anon, authenticated using (true)`
--     on users, tickets (now tasks), activity_logs and 9 more tables;
--     20260506000000 added the same on ticket_extensions (now task_extensions).
--     `users` holds plaintext Slack user tokens (xoxp, chat:write) and Google
--     refresh tokens, so anyone with the anon key could read them.
--   * About 50 later tables (scheduled_emails, daily_briefings, brain_memories,
--     payroll_entries, mrr_entries, email_drafts, task_messages, inbox_privacy,
--     ...) never enabled RLS at all, which under the default grants makes them
--     readable AND writable with the anon key. A forged scheduled_emails row
--     would be sent by the scheduled-emails runner.
--   * SECURITY DEFINER functions (offboard_user, recent_inbound_missive_messages,
--     dazos_push_attempt, get_secret if present, ...) were callable by both
--     roles — see 20260923140000 for why revoking only PUBLIC never worked.
--   * storage.objects policy ticket_attachments_public_read (no TO clause, so
--     it applies to anon) lets the anon key LIST the ticket-attachments bucket
--     — every client onboarding upload, SOP file and image path. The bucket
--     is public, so files stay downloadable by URL without that policy.
--
-- WHY THIS IS SAFE FOR THE APP
--
-- Every data read and write in this codebase goes through the service-role
-- client (src/lib/supabase-admin.ts; ~290 files), which bypasses RLS and keeps
-- all of its grants. The anon/cookie clients are used only for Supabase Auth
-- (login, signup, password reset, session refresh in middleware) — none of
-- them calls .from(), .rpc(), .channel() or .storage. There is no Realtime,
-- no Edge Function and no auth hook in this repo. Storage uploads/removals
-- use the service role and public URLs are built locally (getPublicUrl).
--
-- WHAT THIS DOES (idempotent; safe to run twice)
--
--   P. Pre-flight: aborts with a list if any object in `public` is owned by a
--      role the runner can't act for (ENABLE RLS needs ownership; REVOKE on a
--      foreign object silently does nothing).
--   0. Snapshots policies, table ACLs + RLS flags, function ACLs and the
--      default privileges into the private schema p0_acl_backup (first run
--      wins; stored as text so it never blocks a Postgres major upgrade), for
--      supabase/scripts/20261104_p0_rollback_anon_lockdown.sql.
--   1. Enables RLS on every table in `public` (no policies — the service role
--      doesn't need them).
--   2. Drops every `public`-schema policy that applies to anon, authenticated
--      or PUBLIC, and the storage listing policy above.
--   3. Revokes all table/view/sequence privileges (including column grants)
--      from PUBLIC, anon and authenticated.
--   4. Revokes EXECUTE on every non-extension, non-trigger routine in `public`
--      from PUBLIC, anon and authenticated, and grants it to service_role.
--      Trigger functions are skipped: they can't be called through the API,
--      and leaving them alone keeps the auth.users signup trigger as it is.
--   5. Changes the default privileges so tables and sequences created later
--      by `postgres` are not granted to anon / authenticated. NEW TABLES
--      STILL NEED `enable row level security`, and new SECURITY DEFINER
--      functions still need their own revoke (see section 5).
--   6. Ends with a verify grid that must be EMPTY.
--
-- BEFORE APPLYING: run supabase/scripts/20261104_p0_exposure_check.sql and
-- keep its result grid. AFTER: run 20261104_p0_tamper_review.sql, and pull
-- the API logs (see that script's header) while they are still retained.
-- Tokens that were readable (users.slack_user_token, Google tokens, and the
-- Anthropic key if get_secret showed up as callable) should be treated as
-- leaked and rotated — see the PR description.
--
-- Apply MANUALLY in the Supabase SQL editor (it runs the script as one
-- transaction as `postgres`). Merging the PR runs nothing.

-- Fail fast instead of queueing app traffic behind a long-held lock, and
-- resolve nothing implicitly: every name below is schema-qualified, and the
-- snapshot's signatures/expressions come out fully qualified.
set local lock_timeout = '5s';
set local search_path = '';

-- ---------------------------------------------------------------------------
-- P. Ownership pre-flight
-- ---------------------------------------------------------------------------

do $$
declare
  bad text;
begin
  select string_agg(kind || ' ' || name || ' (owner ' || owner || ')', '; ')
    into bad
  from (
    select 'table' as kind, c.relname::text as name, c.relowner::regrole::text as owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and not pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                        and d.objid = c.oid and d.deptype = 'e')
    union all
    select 'routine', p.oid::pg_catalog.regprocedure::text, p.proowner::regrole::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER')
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                        and d.objid = p.oid and d.deptype = 'e')
  ) x;
  if bad is not null then
    raise exception 'P0 lockdown aborted, nothing changed: these public objects are owned by roles % cannot act for: %. Change their owner to postgres (alter ... owner to postgres) or run as their owner, then re-run.', current_user, bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Snapshot (first run wins: on conflict do nothing). Text, not aclitem.
-- ---------------------------------------------------------------------------

create schema if not exists p0_acl_backup;
revoke all on schema p0_acl_backup from public, anon, authenticated;

create table if not exists p0_acl_backup.policies (
  schemaname  text not null,
  tablename   text not null,
  policyname  text not null,
  permissive  text,
  roles       text[],
  cmd         text,
  qual        text,
  with_check  text,
  captured_at timestamptz not null default pg_catalog.now(),
  primary key (schemaname, tablename, policyname)
);

create table if not exists p0_acl_backup.relations (
  relname     text primary key,
  relkind     text not null,
  rls_enabled boolean not null,
  relacl      text[],
  captured_at timestamptz not null default pg_catalog.now()
);

create table if not exists p0_acl_backup.functions (
  signature   text primary key,
  is_definer  boolean not null,
  proacl      text[],
  owner_name  text not null,
  captured_at timestamptz not null default pg_catalog.now()
);

create table if not exists p0_acl_backup.default_acls (
  objtype     text primary key,
  defaclacl   text[],
  captured_at timestamptz not null default pg_catalog.now()
);

revoke all on all tables in schema p0_acl_backup from public, anon, authenticated;

insert into p0_acl_backup.policies (schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check)
select pol.schemaname::text, pol.tablename::text, pol.policyname::text, pol.permissive, pol.roles::text[], pol.cmd, pol.qual, pol.with_check
from pg_catalog.pg_policies pol
where (pol.schemaname = 'public'
       and pol.roles operator(pg_catalog.&&) array['anon', 'authenticated', 'public']::name[])
   or (pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'ticket_attachments_public_read')
on conflict (schemaname, tablename, policyname) do nothing;

insert into p0_acl_backup.relations (relname, relkind, rls_enabled, relacl)
select c.relname::text, c.relkind::text, c.relrowsecurity, c.relacl::text[]
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
on conflict (relname) do nothing;

insert into p0_acl_backup.functions (signature, is_definer, proacl, owner_name)
select p.oid::pg_catalog.regprocedure::text, p.prosecdef, p.proacl::text[], p.proowner::regrole::text
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prorettype operator(pg_catalog.<>) 'pg_catalog.trigger'::pg_catalog.regtype
  and not exists (select 1 from pg_catalog.pg_depend d
                  where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                    and d.objid = p.oid and d.deptype = 'e')
on conflict (signature) do nothing;

insert into p0_acl_backup.default_acls (objtype, defaclacl)
select d.defaclobjtype::text, d.defaclacl::text[]
from pg_catalog.pg_default_acl d
where d.defaclrole = 'postgres'::regrole
  and d.defaclnamespace = 'public'::regnamespace
on conflict (objtype) do nothing;

-- ---------------------------------------------------------------------------
-- 1. RLS on for every table in public (tables owned by an extension excluded)
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                        and d.objid = c.oid and d.deptype = 'e')
  loop
    execute pg_catalog.format('alter table public.%I enable row level security', r.relname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Drop every policy that lets anon / authenticated / PUBLIC in, plus the
--    storage listing policy (guarded: a permission problem on the storage
--    schema must not undo the rest — the verify grid reports it instead).
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select pol.tablename, pol.policyname
    from pg_catalog.pg_policies pol
    where pol.schemaname = 'public'
      and pol.roles operator(pg_catalog.&&) array['anon', 'authenticated', 'public']::name[]
  loop
    execute pg_catalog.format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

do $$
begin
  if pg_catalog.to_regclass('storage.objects') is not null then
    begin
      execute 'drop policy if exists "ticket_attachments_public_read" on storage.objects';
    exception when insufficient_privilege then
      null;  -- surfaces as a row in the verify grid below
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Table, view and sequence privileges (REVOKE ALL on a table also removes
--    column-level grants)
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Routine EXECUTE (named roles — revoking PUBLIC alone does not work on
--    Supabase, see 20260923140000). ROUTINE covers functions, procedures and
--    aggregates.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select p.oid::pg_catalog.regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype operator(pg_catalog.<>) 'pg_catalog.trigger'::pg_catalog.regtype
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                        and d.objid = p.oid and d.deptype = 'e')
  loop
    execute pg_catalog.format('revoke all on routine %s from public, anon, authenticated', r.sig);
    execute pg_catalog.format('grant execute on routine %s to service_role', r.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Defaults for objects `postgres` creates from now on
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
-- Removes Supabase's per-schema EXECUTE grant to anon/authenticated. It can
-- NOT remove Postgres' built-in, global "EXECUTE to PUBLIC" on new functions
-- (a per-schema REVOKE only undoes per-schema GRANTs), and changing the global
-- default would also hit other schemas such as missiveclone's. So a function
-- created later is still callable by anon through PUBLIC: harmless for a
-- SECURITY INVOKER function (anon has no table privileges any more), but
-- every new SECURITY DEFINER function must keep doing
--   revoke all on function ... from public, anon, authenticated;
--   grant execute on function ... to service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

-- Make sure the service role keeps getting what it uses today.
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- 6. Verify. The SQL editor shows only the last result grid and swallows
--    RAISE NOTICE, so this is a SELECT. EXPECT ZERO ROWS. Any row is
--    something anon or a signed-in JWT can still reach — do not walk away.
-- ---------------------------------------------------------------------------

select c.relname::text as object_name,
       'table/view' as object_kind,
       c.relrowsecurity::text as detail
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and (
    (c.relkind in ('r', 'p') and not c.relrowsecurity
       and not exists (select 1 from pg_catalog.pg_depend d
                       where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                         and d.objid = c.oid and d.deptype = 'e'))
    or pg_catalog.has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    or pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE')
    or pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE')
  )
union all
select p.oid::pg_catalog.regprocedure::text,
       case when p.prosecdef then 'routine (security definer)' else 'routine' end,
       'anon/authenticated can execute'
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prorettype operator(pg_catalog.<>) 'pg_catalog.trigger'::pg_catalog.regtype
  and not exists (select 1 from pg_catalog.pg_depend d
                  where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                    and d.objid = p.oid and d.deptype = 'e')
  and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))
union all
select pol.policyname::text || ' on ' || pol.schemaname::text || '.' || pol.tablename::text,
       'policy',
       pg_catalog.array_to_string(pol.roles, ',')
from pg_catalog.pg_policies pol
where (pol.schemaname = 'public'
       and pol.roles operator(pg_catalog.&&) array['anon', 'authenticated', 'public']::name[])
   or (pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'ticket_attachments_public_read')
union all
select 'default privileges for ' || d.defaclobjtype::text,
       'default acl',
       a.grantee::regrole::text || ' ' || a.privilege_type
from pg_catalog.pg_default_acl d
cross join lateral pg_catalog.aclexplode(d.defaclacl) a
where d.defaclrole = 'postgres'::regrole
  and d.defaclnamespace = 'public'::regnamespace
  and d.defaclobjtype in ('r', 'S')
  and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole));
