-- Executive AI Assistant — P9: brief refs kept until the brief DM is purged (P9 contract §3.1).
--
-- Problem: P8's RPC 7 (exec_brief_purge_expired) empties a brief's three ref arrays when it nulls the content at
-- content_expires_at (the local date + 30 days), and P8's scrubs (RPCs 5 and 6) only select rows whose content is still
-- there. The brief DM in Slack lives until P6's DM purge deletes it at retention_days_chat (M9, K12). So from day 30
-- until then, a tombstone, a Slack delete, a deletion request or a reading revoke can't find the row, and the C15
-- follow-up never replaces the DM with the "removed" note.
--
-- This file adds three VERSIONED functions next to P8's v1 RPCs 5, 6 and 7 (P6 C43's pattern):
--   exec_brief_purge_expired_v2   RPC 7's body with three changes: at content expiry the refs are emptied only when the
--                                 DM can't exist any more; a release step empties the kept refs once it can't; the row
--                                 delete waits while the DM may exist, up to a hard ceiling (the local date + 740 days).
--   exec_brief_scrub_threads_v2   RPC 5's body; it also reaches a delivered (or delivery_unknown) row whose content was
--   exec_brief_scrub_slack_v2     purged (RPC 6 the same): its refs are emptied and scrubbed_at is set, which arms C15
--                                 (the whole DM becomes the note).
-- "The DM may exist" (dm_live), inlined in the purge (s = the principal's exec_settings row, left joined):
--   a delivered row whose ts is still in P6's post ledger (P6's DM purge and RPC 4 delete the ledger row with the
--   message), or delivered within least(retention_days_chat, 730) + 2 days; a delivery_unknown row whose delivery started
--   within that window. Only ids and timestamps are kept longer, never text.
--
-- P8's v1 functions are NOT touched: P8's file drops and re-creates them, so a hand re-run of P8's file restores v1 and
-- leaves these three in place. No table, column, index or CHECK of any earlier phase is created or changed here.
-- DD's brief-store.ts calls the _v2 functions first and falls back to v1 on 42883 / PGRST202 (code first is safe).
--
-- Security: SECURITY INVOKER, search_path pinned, EXECUTE for service_role only (revoked from PUBLIC, anon and
-- authenticated). Idempotent. Apply MANUALLY in the Supabase SQL editor AFTER 20261111100000_exec_brief.sql; the verify
-- grid at the end must be all ok, then re-run P8's grid.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: refuse, with nothing changed, a database without P8's brief, P6's post ledger or the chat retention.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.exec_briefs') is null
     or to_regprocedure('public.exec_brief_scrub_threads(text, text[])') is null
     or to_regprocedure('public.exec_brief_scrub_slack(text, text[], text[], boolean)') is null
     or to_regprocedure('public.exec_brief_purge_expired(timestamptz, integer, date)') is null
     or to_regprocedure('public.exec_brief_scrub_content(jsonb, text[], text[], text[], boolean, text)') is null
     or to_regprocedure('public.exec_brief_ref_array(jsonb, text)') is null then
    raise exception 'exec P9 aborted, nothing changed: the P8 brief is missing (apply 20261111100000_exec_brief.sql first)';
  end if;
  if (select count(*) from pg_catalog.pg_attribute a
       where a.attrelid = to_regclass('public.exec_slack_posts') and a.attnum > 0 and not a.attisdropped
         and a.attname in ('principal_id', 'channel_id', 'ts')) <> 3 then
    raise exception 'exec P9 aborted, nothing changed: exec_slack_posts (principal_id, channel_id, ts) is missing (apply 20261108100000_exec_slack.sql first)';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = to_regclass('public.exec_settings') and a.attnum > 0 and not a.attisdropped
                    and a.attname = 'retention_days_chat') then
    raise exception 'exec P9 aborted, nothing changed: exec_settings.retention_days_chat is missing (the P2a foundation is incomplete)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. exec_brief_purge_expired_v2 (RPC 7 v2; called by the system purge through brief-store.ts)
-- ---------------------------------------------------------------------------
-- All dates come from the app (C28), never now() in SQL. Batched with skip locked, like v1; the release step and the
-- row delete see the content step's rows in the same call.

drop function if exists public.exec_brief_purge_expired_v2(timestamptz, integer, date);
create or replace function public.exec_brief_purge_expired_v2(p_now timestamptz, p_limit integer, p_mention_cutoff date) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lim      integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_content  integer := 0;
  v_released integer := 0;
  v_rows     integer := 0;
  v_checkins integer := 0;
  v_mentions integer := 0;
begin
  if p_now is null or p_mention_cutoff is null then
    raise exception 'exec_brief_purge_expired_v2: now and the mention cutoff are required';
  end if;

  -- (1) Content expiry: the content goes, as in v1; the ref arrays go only when the DM can't exist any more.
  with c as (
    select b.id,
           coalesce(
             (b.status = 'delivered' and b.slack_ts is not null and (
                exists (select 1 from public.exec_slack_posts p
                         where p.principal_id = b.principal_id and p.channel_id = b.slack_channel_id and p.ts = b.slack_ts)
                or b.delivered_at > p_now - make_interval(days => least(coalesce(s.retention_days_chat, 90), 730) + 2)))
             or (b.status = 'delivery_unknown'
                 and b.delivery_started_at > p_now - make_interval(days => least(coalesce(s.retention_days_chat, 90), 730) + 2)),
             true) as dm_live
      from public.exec_briefs b
      left join public.exec_settings s on s.principal_id = b.principal_id
     where b.content is not null and b.content_expires_at < p_now
     order by b.content_expires_at
     limit v_lim
     for update of b skip locked
  )
  update public.exec_briefs b
     set content = null, content_purged_at = p_now,
         ref_thread_ids     = case when c.dm_live then b.ref_thread_ids else '{}' end,
         ref_slack_keys     = case when c.dm_live then b.ref_slack_keys else '{}' end,
         ref_slack_channels = case when c.dm_live then b.ref_slack_channels else '{}' end,
         updated_at = now()
    from c where b.id = c.id;
  get diagnostics v_content = row_count;

  -- (2) The release: a purged row's kept refs go once the DM can't exist any more, or once the DM shows only the note
  --     (scrubbed after it was delivered, and that scrub was followed up).
  with r as (
    select b.id
      from public.exec_briefs b
      left join public.exec_settings s on s.principal_id = b.principal_id
     where b.content is null
       and (cardinality(b.ref_thread_ids) > 0 or cardinality(b.ref_slack_keys) > 0 or cardinality(b.ref_slack_channels) > 0)
       and (not coalesce(
              (b.status = 'delivered' and b.slack_ts is not null and (
                 exists (select 1 from public.exec_slack_posts p
                          where p.principal_id = b.principal_id and p.channel_id = b.slack_channel_id and p.ts = b.slack_ts)
                 or b.delivered_at > p_now - make_interval(days => least(coalesce(s.retention_days_chat, 90), 730) + 2)))
              or (b.status = 'delivery_unknown'
                  and b.delivery_started_at > p_now - make_interval(days => least(coalesce(s.retention_days_chat, 90), 730) + 2)),
              true)
            or (b.delivered_at is not null and b.scrubbed_at > b.delivered_at and b.dm_followed_at >= b.scrubbed_at))
     order by b.content_expires_at
     limit v_lim
     for update of b skip locked
  )
  update public.exec_briefs b
     set ref_thread_ids = '{}', ref_slack_keys = '{}', ref_slack_channels = '{}', updated_at = now()
    from r where b.id = r.id;
  get diagnostics v_released = row_count;

  -- (3) Rows: v1's predicate (P8 fixer security-2: a still-posted DD-bot mini-brief keeps its row up to 7 more days), and
  --     the row waits while its DM may exist, up to expires_at + 560 days (the local date + 740 days).
  with d as (
    select b.id
      from public.exec_briefs b
      left join public.exec_settings s on s.principal_id = b.principal_id
     where b.expires_at < p_now
       and (b.fallback_slack_ts is null or b.fallback_deleted_at is not null or b.expires_at < p_now - interval '7 days')
       and (not coalesce(
              (b.status = 'delivered' and b.slack_ts is not null and (
                 exists (select 1 from public.exec_slack_posts p
                          where p.principal_id = b.principal_id and p.channel_id = b.slack_channel_id and p.ts = b.slack_ts)
                 or b.delivered_at > p_now - make_interval(days => least(coalesce(s.retention_days_chat, 90), 730) + 2)))
              or (b.status = 'delivery_unknown'
                  and b.delivery_started_at > p_now - make_interval(days => least(coalesce(s.retention_days_chat, 90), 730) + 2)),
              true)
            or b.expires_at < p_now - interval '560 days')
     order by b.expires_at
     limit v_lim
     for update of b skip locked
  )
  delete from public.exec_briefs b using d where b.id = d.id;
  get diagnostics v_rows = row_count;

  -- (4) Check-ins and mentions, as v1.
  with d as (select id from public.exec_brief_checkins where purge_at < p_now order by purge_at limit v_lim for update skip locked)
  delete from public.exec_brief_checkins k using d where k.id = d.id;
  get diagnostics v_checkins = row_count;
  with d as (
    select principal_id, fingerprint from public.exec_brief_mentions where last_mentioned_on < p_mention_cutoff
     limit v_lim for update skip locked
  )
  delete from public.exec_brief_mentions m using d where m.principal_id = d.principal_id and m.fingerprint = d.fingerprint;
  get diagnostics v_mentions = row_count;

  return jsonb_build_object('contentPurged', v_content, 'refsReleased', v_released, 'briefsDeleted', v_rows,
                            'checkinsDeleted', v_checkins, 'mentionsDeleted', v_mentions);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. exec_brief_scrub_threads_v2 (RPC 5 v2): also a purged row whose DM may still be in Slack
-- ---------------------------------------------------------------------------
-- On a purged row exec_brief_scrub_content(null, ...) is null (the content stays null; content_presence_check holds
-- because content_purged_at is set), exec_brief_ref_array(null, key) is '{}', and scrubbed_at = now() arms C15.

drop function if exists public.exec_brief_scrub_threads_v2(text, text[]);
create or replace function public.exec_brief_scrub_threads_v2(p_principal text, p_thread_ids text[]) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  if p_principal is null then raise exception 'exec_brief_scrub_threads_v2: p_principal is required'; end if;
  if p_thread_ids is null or cardinality(p_thread_ids) = 0 then return 0; end if;
  if cardinality(p_thread_ids) > 500 then raise exception 'exec_brief_scrub_threads_v2: at most 500 thread ids per call'; end if;
  with hit as (
    select b.id,
           public.exec_brief_scrub_content(b.content, p_thread_ids, '{}'::text[], '{}'::text[], false,
                                           '[Removed: restricted sender]') as c
      from public.exec_briefs b
     where b.principal_id = p_principal
       and (b.content is not null or (b.content_purged_at is not null and (b.status in ('delivered', 'delivery_unknown'))))
       and b.ref_thread_ids && p_thread_ids
     for update
  )
  update public.exec_briefs b
     set content = hit.c,
         ref_thread_ids = public.exec_brief_ref_array(hit.c, 'threadIds'),
         ref_slack_keys = public.exec_brief_ref_array(hit.c, 'slackKeys'),
         ref_slack_channels = public.exec_brief_ref_array(hit.c, 'slackChannels'),
         scrubbed_at = now(), updated_at = now()
    from hit
   where b.id = hit.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. exec_brief_scrub_slack_v2 (RPC 6 v2): the same reach; p_all reaches a purged row through its kept channels
-- ---------------------------------------------------------------------------

drop function if exists public.exec_brief_scrub_slack_v2(text, text[], text[], boolean);
create or replace function public.exec_brief_scrub_slack_v2(
  p_principal text,
  p_slack_keys text[],   -- m:<channel>:<ts> and d:<channel>:<YYYY-MM-DD>
  p_channels text[],     -- conversation-level purges
  p_all boolean          -- the reading half is gone: every Slack-derived line
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
  v_keys text[] := coalesce(p_slack_keys, '{}'::text[]);
  v_channels text[] := coalesce(p_channels, '{}'::text[]);
begin
  if p_principal is null then raise exception 'exec_brief_scrub_slack_v2: p_principal is required'; end if;
  if cardinality(v_keys) > 500 or cardinality(v_channels) > 500 then
    raise exception 'exec_brief_scrub_slack_v2: at most 500 keys and 500 channels per call';
  end if;
  if not coalesce(p_all, false) and cardinality(v_keys) = 0 and cardinality(v_channels) = 0 then return 0; end if;
  with hit as (
    select b.id,
           public.exec_brief_scrub_content(b.content, '{}'::text[], v_keys, v_channels, coalesce(p_all, false),
                                           '[Removed: no longer available in Slack]') as c
      from public.exec_briefs b
     where b.principal_id = p_principal
       and (b.content is not null or (b.content_purged_at is not null and (b.status in ('delivered', 'delivery_unknown'))))
       and (b.ref_slack_keys && v_keys or b.ref_slack_channels && v_channels
            or (coalesce(p_all, false) and cardinality(b.ref_slack_channels) > 0))
     for update
  )
  update public.exec_briefs b
     set content = hit.c,
         ref_thread_ids = public.exec_brief_ref_array(hit.c, 'threadIds'),
         ref_slack_keys = public.exec_brief_ref_array(hit.c, 'slackKeys'),
         ref_slack_channels = public.exec_brief_ref_array(hit.c, 'slackChannels'),
         scrubbed_at = now(), updated_at = now()
    from hit
   where b.id = hit.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Lockdown
-- ---------------------------------------------------------------------------

revoke all on function public.exec_brief_purge_expired_v2(timestamptz, integer, date) from public, anon, authenticated;
revoke all on function public.exec_brief_scrub_threads_v2(text, text[]) from public, anon, authenticated;
revoke all on function public.exec_brief_scrub_slack_v2(text, text[], text[], boolean) from public, anon, authenticated;
grant execute on function public.exec_brief_purge_expired_v2(timestamptz, integer, date) to service_role;
grant execute on function public.exec_brief_scrub_threads_v2(text, text[]) to service_role;
grant execute on function public.exec_brief_scrub_slack_v2(text, text[], text[], boolean) to service_role;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify. The SQL editor shows only the last grid. EXPECT every ok = true.
-- Failing rows sort first, and `detail` then shows what to fix. Checked for
-- every exec_ table, sequence and function (this file's and the earlier ones):
--   * RLS on and no policies.
--   * anon/authenticated hold nothing: every table privilege counts
--     (TRUNCATE ignores RLS), and so do column grants and sequences.
--   * service_role can read/write every table, use every sequence and call
--     every RPC.
-- And for this file:
--   * the three _v2 functions: SECURITY INVOKER with search_path pinned, one
--     signature each, and the words that make each one v2 in its body;
--   * P8's v1 RPCs 5, 6 and 7 still present and still P8's (no v2 body in them);
--   * what this file relies on from P2a, P6 and P8, so a later re-apply of an
--     earlier phase that loses one turns a row false.
-- Re-run P8's grid after this one (§8 setup step b).
-- ---------------------------------------------------------------------------

select check_name, ok, detail
from (
  select 'RLS on: ' || c.relname as check_name, c.relrowsecurity as ok, null::text as detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind = 'r'
  union all
  select 'no policies: ' || c.relname, pol.names is null, pol.names
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (select string_agg(p.policyname::text, ', ') as names
                      from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) pol
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind = 'r'
  union all
  select 'no anon/authenticated access: ' || c.relname, not x.bad,
         case when x.bad then coalesce(c.relacl::text, '(owner only)') || coalesce(' columns: ' || x.cols, '') end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    select case when c.relkind = 'S' then
                  has_sequence_privilege('anon', c.oid, 'USAGE, SELECT, UPDATE')
                  or has_sequence_privilege('authenticated', c.oid, 'USAGE, SELECT, UPDATE')
                else
                  has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  or has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
                  or has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
           end as bad,
           (select string_agg(a.attname::text || ' ' || a.attacl::text, ', ')
            from pg_attribute a where a.attrelid = c.oid and a.attacl is not null) as cols) x
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind in ('r', 'S')
  union all
  select case when c.relkind = 'S' then 'service_role usage: ' else 'service_role access: ' end || c.relname,
         x.good, case when not x.good then coalesce(c.relacl::text, '(owner only)') end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    select case when c.relkind = 'S' then has_sequence_privilege('service_role', c.oid, 'USAGE')
                else has_table_privilege('service_role', c.oid, 'SELECT')
                     and has_table_privilege('service_role', c.oid, 'INSERT')
                     and has_table_privilege('service_role', c.oid, 'UPDATE')
                     and has_table_privilege('service_role', c.oid, 'DELETE')
           end as good) x
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind in ('r', 'S')
  union all
  select 'no anon/authenticated execute: ' || p.proname, not x.bad,
         case when x.bad then coalesce(p.proacl::text, '(default: PUBLIC may execute)') end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (select has_function_privilege('anon', p.oid, 'EXECUTE')
                             or has_function_privilege('authenticated', p.oid, 'EXECUTE') as bad) x
  where n.nspname = 'public' and p.proname like 'exec\_%'
  union all
  select 'service_role execute: ' || p.proname, x.good,
         case when not x.good then coalesce(p.proacl::text, '(default: PUBLIC may execute)') end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (select has_function_privilege('service_role', p.oid, 'EXECUTE') as good) x
  where n.nspname = 'public' and p.proname like 'exec\_%'
  union all
  select 'security invoker, search_path pinned: ' || e.fn, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_brief_purge_expired_v2(timestamptz,integer,date)'),
    ('exec_brief_scrub_threads_v2(text,text[])'),
    ('exec_brief_scrub_slack_v2(text,text[],text[],boolean)')
  ) e(fn)
  left join lateral (
    select not p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'::text[])) as ok,
           case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end
             || ', config ' || coalesce(p.proconfig::text, '(none)') as found
    from pg_proc p
    where p.oid = to_regprocedure('public.' || e.fn)
  ) x on true
  union all
  select 'one signature: ' || e.name, x.n = 1, case when x.n <> 1 then x.n::text || ' signatures: ' || coalesce(x.sigs, '') end
  from (values ('exec_brief_purge_expired_v2'), ('exec_brief_scrub_threads_v2'), ('exec_brief_scrub_slack_v2')) e(name)
  cross join lateral (
    select count(*)::int as n, string_agg(p.oid::regprocedure::text, '; ') as sigs
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = e.name
  ) x
  union all
  -- §3.1: the words each v2 body must hold (the dm_live predicate, the release and its count, the ceiling; the reach).
  select 'v2 body (3.1): ' || e.fn, coalesce(x.found and x.missing is null, false),
         case when not coalesce(x.found and x.missing is null, false) then coalesce('prosrc lacks: ' || x.missing, '(missing)') end
  from (values
    ('exec_brief_purge_expired_v2(timestamptz,integer,date)',
     array['public.exec_slack_posts', 'retention_days_chat', '''refsReleased''', 'interval ''560 days''', 'skip locked']),
    ('exec_brief_scrub_threads_v2(text,text[])',
     array['b.content_purged_at is not null', '''delivery_unknown''', 'public.exec_brief_ref_array']),
    ('exec_brief_scrub_slack_v2(text,text[],text[],boolean)',
     array['b.content_purged_at is not null', '''delivery_unknown''', 'public.exec_brief_ref_array'])
  ) e(fn, words)
  left join lateral (
    select true as found, (select string_agg(w, ', ') from unnest(e.words) w where strpos(p.prosrc, w) = 0) as missing
    from pg_proc p where p.oid = to_regprocedure('public.' || e.fn)
  ) x on true
  union all
  -- P9 never redefines P8's v1: each is present, and none holds the word that marks its v2 body.
  select 'still present and P8''s (v1): ' || e.fn, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_brief_purge_expired(timestamptz,integer,date)', 'exec_slack_posts'),
    ('exec_brief_scrub_threads(text,text[])', 'content_purged_at'),
    ('exec_brief_scrub_slack(text,text[],text[],boolean)', 'content_purged_at')
  ) e(fn, v2word)
  left join lateral (
    select strpos(p.prosrc, e.v2word) = 0 as ok, 'holds ' || e.v2word || ' (P8''s function was redefined)' as found
    from pg_proc p where p.oid = to_regprocedure('public.' || e.fn)
  ) x on true
  union all
  select 'relies on (P8): function ' || e.fn, to_regprocedure('public.' || e.fn) is not null,
         case when to_regprocedure('public.' || e.fn) is null then '(missing)' end
  from (values ('exec_brief_scrub_content(jsonb,text[],text[],text[],boolean,text)'), ('exec_brief_ref_array(jsonb,text)')) e(fn)
  union all
  select 'relies on (' || e.phase || '): column ' || e.tbl || '.' || e.col, coalesce(x.typ = e.typ, false),
         case when not coalesce(x.typ = e.typ, false) then coalesce(x.typ, '(missing)') end
  from (values
    ('P8', 'exec_briefs', 'status', 'text'), ('P8', 'exec_briefs', 'content', 'jsonb'),
    ('P8', 'exec_briefs', 'content_expires_at', 'timestamp with time zone'),
    ('P8', 'exec_briefs', 'content_purged_at', 'timestamp with time zone'),
    ('P8', 'exec_briefs', 'expires_at', 'timestamp with time zone'),
    ('P8', 'exec_briefs', 'ref_thread_ids', 'text[]'), ('P8', 'exec_briefs', 'ref_slack_keys', 'text[]'),
    ('P8', 'exec_briefs', 'ref_slack_channels', 'text[]'), ('P8', 'exec_briefs', 'slack_channel_id', 'text'),
    ('P8', 'exec_briefs', 'slack_ts', 'text'), ('P8', 'exec_briefs', 'delivered_at', 'timestamp with time zone'),
    ('P8', 'exec_briefs', 'delivery_started_at', 'timestamp with time zone'),
    ('P8', 'exec_briefs', 'scrubbed_at', 'timestamp with time zone'),
    ('P8', 'exec_briefs', 'dm_followed_at', 'timestamp with time zone'),
    ('P8', 'exec_briefs', 'fallback_slack_ts', 'text'), ('P8', 'exec_briefs', 'fallback_deleted_at', 'timestamp with time zone'),
    ('P6', 'exec_slack_posts', 'principal_id', 'text'), ('P6', 'exec_slack_posts', 'channel_id', 'text'),
    ('P6', 'exec_slack_posts', 'ts', 'text'), ('P2a', 'exec_settings', 'retention_days_chat', 'integer')
  ) e(phase, tbl, col, typ)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) as typ from pg_attribute a
     where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = e.col and a.attnum > 0 and not a.attisdropped
  ) x on true
) checks
order by ok, check_name;
