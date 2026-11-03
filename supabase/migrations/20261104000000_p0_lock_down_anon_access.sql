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
--     payroll_entries, mrr_entries, email_drafts, task_messages, ...) never
--     enabled RLS at all, which under the default grants makes them readable
--     AND writable with the anon key. A forged scheduled_emails row would be
--     sent by the scheduled-emails runner.
--   * SECURITY DEFINER functions (offboard_user, recent_inbound_missive_messages,
--     dazos_push_attempt, get_secret if present, ...) were callable by both
--     roles — see 20260923140000 for why revoking only PUBLIC never worked.
--
-- WHY THIS IS SAFE FOR THE APP
--
-- Every data read and write in this codebase goes through the service-role
-- client (src/lib/supabase-admin.ts; ~290 files), which bypasses RLS and keeps
-- all of its grants. The anon/cookie clients are used only for Supabase Auth
-- (login, signup, password reset, session refresh in middleware) — none of
-- them calls .from(), .rpc(), .channel() or .storage. There is no Realtime,
-- no Edge Function and no auth hook in this repo. Storage is a separate
-- schema and is untouched (the ticket-attachments public-read policy keys on
-- the bucket id only).
--
-- WHAT THIS DOES (idempotent; safe to run twice)
--
--   0. Snapshots the current policies, table ACLs/RLS flags and function ACLs
--      into the private schema p0_acl_backup (first run wins), so
--      supabase/scripts/20261104_p0_rollback_anon_lockdown.sql can restore
--      the old state in an emergency.
--   1. Enables RLS on every table in `public` (none get policies — the
--      service role doesn't need them).
--   2. Drops every `public`-schema policy that applies to anon, authenticated
--      or PUBLIC.
--   3. Revokes all table/view/sequence privileges from anon and authenticated.
--   4. Revokes EXECUTE on every non-extension, non-trigger function in
--      `public` from PUBLIC, anon and authenticated, and grants it to
--      service_role. Trigger functions are skipped: they can't be called
--      through the API, and leaving them alone keeps the auth.users signup
--      trigger exactly as it is.
--   5. Changes the default privileges so tables and sequences created later
--      by `postgres` (migrations, the dashboard) are not granted to anon /
--      authenticated either. NEW TABLES STILL NEED `enable row level security`
--      — this only removes the grants. New SECURITY DEFINER functions still
--      need their own revoke (see the note in section 5).
--   6. Ends with the exposure check, which should return ZERO rows.
--
-- BEFORE APPLYING: run supabase/scripts/20261104_p0_exposure_check.sql and
-- keep its result grid. AFTER: run 20261104_p0_tamper_review.sql to look for
-- rows nobody in the app wrote while the tables were open.
--
-- Apply MANUALLY in the Supabase SQL editor. Merging the PR runs nothing.

-- ---------------------------------------------------------------------------
-- 0. Snapshot (first run wins: on conflict do nothing)
-- ---------------------------------------------------------------------------

create schema if not exists p0_acl_backup;
revoke all on schema p0_acl_backup from public, anon, authenticated;

create table if not exists p0_acl_backup.policies (
  tablename   name not null,
  policyname  name not null,
  permissive  text,
  roles       name[],
  cmd         text,
  qual        text,
  with_check  text,
  captured_at timestamptz not null default now(),
  primary key (tablename, policyname)
);

create table if not exists p0_acl_backup.relations (
  relname     name primary key,
  relkind     text not null,
  rls_enabled boolean not null,
  relacl      aclitem[],
  captured_at timestamptz not null default now()
);

create table if not exists p0_acl_backup.functions (
  signature   text primary key,
  is_definer  boolean not null,
  proacl      aclitem[],
  owner_oid   oid not null,
  captured_at timestamptz not null default now()
);

revoke all on all tables in schema p0_acl_backup from public, anon, authenticated;

insert into p0_acl_backup.policies (tablename, policyname, permissive, roles, cmd, qual, with_check)
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and roles && array['anon', 'authenticated', 'public']::name[]
on conflict (tablename, policyname) do nothing;

insert into p0_acl_backup.relations (relname, relkind, rls_enabled, relacl)
select c.relname, c.relkind::text, c.relrowsecurity, c.relacl
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
on conflict (relname) do nothing;

insert into p0_acl_backup.functions (signature, is_definer, proacl, owner_oid)
select p.oid::regprocedure::text, p.prosecdef, p.proacl, p.proowner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind in ('f', 'p')
  and p.prorettype <> 'trigger'::regtype
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
  )
on conflict (signature) do nothing;

-- ---------------------------------------------------------------------------
-- 1. RLS on for every table in public (tables owned by an extension excluded)
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
      )
  loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Drop every policy that lets anon / authenticated / PUBLIC in
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and roles && array['anon', 'authenticated', 'public']::name[]
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Table, view and sequence privileges
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Function EXECUTE (named roles — revoking PUBLIC alone does not work on
--    Supabase, see 20260923140000)
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and p.prorettype <> 'trigger'::regtype
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke all on routine %s from public, anon, authenticated', r.sig);
    execute format('grant execute on routine %s to service_role', r.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Defaults for objects `postgres` creates from now on
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
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
       c.relrowsecurity as rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and (
    (c.relkind in ('r', 'p') and not c.relrowsecurity
       and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))
    or has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
    or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
  )
union all
select p.oid::regprocedure::text,
       case when p.prosecdef then 'function (security definer)' else 'function' end,
       null,
       has_function_privilege('anon', p.oid, 'EXECUTE'),
       has_function_privilege('authenticated', p.oid, 'EXECUTE')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind in ('f', 'p')
  and p.prorettype <> 'trigger'::regtype
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
union all
select policyname::text || ' on ' || tablename::text, 'policy', null, null, null
from pg_policies
where schemaname = 'public'
  and roles && array['anon', 'authenticated', 'public']::name[];
