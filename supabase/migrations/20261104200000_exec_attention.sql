-- Executive AI Assistant — P2b Needs Attention.
--
--   exec_attention_items  one row per (principal, fingerprint): a situation the
--                         assistant thinks the executive should look at
--                         (overdue work, pending approvals, an unanswered
--                         mention...). Producers recompute their candidates on
--                         a schedule; src/lib/exec/attention.ts reconciles them
--                         with these rows, so the same situation stays one row
--                         across refreshes and its status (seen, snoozed,
--                         dismissed, resolved) survives them.
--
-- The rows hold only short summaries the assistant wrote (title, what
-- happened, why it matters, a labeled suggestion, facts with their source
-- references), never message bodies. Resolved rows are purged after 90 days by
-- the exec.purge job.
--
-- Security: RLS ON with NO policies and nothing granted to anon/authenticated,
-- like every exec_ table (20261104100000_exec_foundation.sql). The app reaches
-- it only through the service role.
--
-- Nothing reads this table until EXEC_ENABLED=true on the app, so applying it
-- early is harmless.
--
-- Idempotent. Apply MANUALLY in the Supabase SQL editor, AFTER
-- 20261104100000_exec_foundation.sql. Merging runs nothing.

set local lock_timeout = '5s';

-- Pre-flight: the foundation must be applied first (the rows belong to an
-- exec_principals row). Aborts before changing anything.
do $$
begin
  if to_regclass('public.exec_principals') is null then
    raise exception 'exec attention aborted, nothing changed: public.exec_principals does not exist (apply 20261104100000_exec_foundation.sql first)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Needs Attention items
-- ---------------------------------------------------------------------------

create table if not exists public.exec_attention_items (
  id               text primary key default ('ea_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id     text not null references public.exec_principals(id) on delete cascade,
  -- Stable identity of the situation, namespaced by source and rule
  -- ("dd:overdue:assignee:u_123"). The prefix check below keeps a row from
  -- claiming another source's namespace, which is what a sync's scope is.
  fingerprint      text not null,
  source           text not null
                     constraint exec_attention_items_source_check check (source in ('dd', 'email', 'slack')),
  -- The producer rule ("overdue_tasks"). A sync resolves only its own kinds.
  kind             text not null,
  category         text not null
                     constraint exec_attention_items_category_check
                     check (category in ('my_action', 'approval', 'delegated', 'intervene', 'fyi', 'on_track')),
  -- Deterministic score from src/lib/exec/priority.ts, clamped to 0..100.
  priority_score   int not null default 0
                     constraint exec_attention_items_score_check check (priority_score between 0 and 100),
  priority_band    text not null
                     constraint exec_attention_items_band_check check (priority_band in ('critical', 'high', 'normal')),
  priority_reasons jsonb not null default '[]'::jsonb
                     constraint exec_attention_items_reasons_check check (jsonb_typeof(priority_reasons) = 'array'),
  title            text not null,
  what_happened    text not null default '',
  why_it_matters   text not null default '',
  -- A suggestion, always shown labeled as one; never a fact.
  recommended_next text,
  -- [{ text, basis: record|derived|ai, refs }], refs = SourceRefs (links allowlisted by refs.ts).
  facts            jsonb not null default '[]'::jsonb
                     constraint exec_attention_items_facts_check check (jsonb_typeof(facts) = 'array'),
  refs             jsonb not null default '[]'::jsonb
                     constraint exec_attention_items_refs_check check (jsonb_typeof(refs) = 'array'),
  -- Changes only when the state he'd want to see again changes (count, age
  -- bucket, ids, status); a seen or owner-resolved row reopens on a new one.
  state_hash       text not null,
  occurred_at      timestamptz,
  status           text not null default 'open'
                     constraint exec_attention_items_status_check
                     check (status in ('open', 'seen', 'snoozed', 'dismissed', 'resolved')),
  snooze_until     timestamptz,
  -- auto: the condition went away. owner: he marked it done.
  resolution       text
                     constraint exec_attention_items_resolution_check check (resolution in ('auto', 'owner')),
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- One row per situation: a refresh updates it instead of adding another.
  constraint exec_attention_items_fingerprint_key unique (principal_id, fingerprint),
  constraint exec_attention_items_fingerprint_check
    check (starts_with(fingerprint, source || ':') and length(fingerprint) between length(source) + 2 and 300),
  -- A resolved row always says how and when, and only a resolved row does:
  -- the purge keys on resolved_at, so a resolved row without one would never
  -- age out.
  constraint exec_attention_items_resolved_check
    check ((status = 'resolved') = (resolution is not null) and (status = 'resolved') = (resolved_at is not null)),
  -- A snoozed row always says until when, and only a snoozed row does.
  constraint exec_attention_items_snooze_check
    check ((status = 'snoozed') = (snooze_until is not null))
);

-- The feed: one principal's items by status, highest priority first.
create index if not exists exec_attention_items_feed_idx
  on public.exec_attention_items (principal_id, status, priority_score desc);
-- A producer's sync reads the live (not resolved) rows of its own source and
-- kinds, to resolve the ones it no longer sees.
create index if not exists exec_attention_items_live_scope_idx
  on public.exec_attention_items (principal_id, source, kind) where status <> 'resolved';
-- The daily purge deletes resolved rows by age.
create index if not exists exec_attention_items_purge_idx
  on public.exec_attention_items (resolved_at) where status = 'resolved';

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, no policies; service_role only
-- ---------------------------------------------------------------------------

alter table public.exec_attention_items enable row level security;

revoke all on public.exec_attention_items from public, anon, authenticated;
grant all on public.exec_attention_items to service_role;

-- So PostgREST sees the new table without waiting for a restart.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify. The SQL editor shows only the last grid. EXPECT every ok = true.
-- Failing rows sort first, and `detail` then shows what to fix. Checked for
-- every exec_ table, sequence and function (this file's and the
-- foundation's):
--   * RLS on and no policies.
--   * anon/authenticated hold nothing: every table privilege counts
--     (TRUNCATE ignores RLS), and so do column grants and sequences.
--   * service_role can read/write every table, use every sequence and call
--     every RPC; the app reaches all of it only as service_role.
-- And for exec_attention_items, the shape the app relies on. `create table if
-- not exists` keeps a table left by an earlier draft of this file as it was,
-- so a missing column, constraint or index shows here instead of failing at
-- runtime:
--   * every column, with its type and nullability;
--   * every named CHECK; the unique (principal_id, fingerprint) that the
--     app's insert-or-ignore targets; the principal FK with ON DELETE CASCADE;
--   * the three indexes, compared by definition.
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
           -- Column grants live on pg_attribute, not in relacl.
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
  select 'columns: exec_attention_items', x.wrong is null, x.wrong
  from (
    select string_agg(e.col || ' ' || e.typ || case when e.required then ' not null' else '' end, ', ' order by e.ord) as wrong
    from (values
      (1, 'id', 'text', true), (2, 'principal_id', 'text', true), (3, 'fingerprint', 'text', true),
      (4, 'source', 'text', true), (5, 'kind', 'text', true), (6, 'category', 'text', true),
      (7, 'priority_score', 'integer', true), (8, 'priority_band', 'text', true),
      (9, 'priority_reasons', 'jsonb', true), (10, 'title', 'text', true), (11, 'what_happened', 'text', true),
      (12, 'why_it_matters', 'text', true), (13, 'recommended_next', 'text', false), (14, 'facts', 'jsonb', true),
      (15, 'refs', 'jsonb', true), (16, 'state_hash', 'text', true),
      (17, 'occurred_at', 'timestamp with time zone', false), (18, 'status', 'text', true),
      (19, 'snooze_until', 'timestamp with time zone', false), (20, 'resolution', 'text', false),
      (21, 'first_seen_at', 'timestamp with time zone', true), (22, 'last_seen_at', 'timestamp with time zone', true),
      (23, 'resolved_at', 'timestamp with time zone', false), (24, 'created_at', 'timestamp with time zone', true),
      (25, 'updated_at', 'timestamp with time zone', true)
    ) e(ord, col, typ, required)
    where not exists (
      select 1 from pg_attribute a
      where a.attrelid = 'public.exec_attention_items'::regclass and a.attnum > 0 and not a.attisdropped
        and a.attname = e.col and format_type(a.atttypid, a.atttypmod) = e.typ and a.attnotnull = e.required)
  ) x
  union all
  select 'checks: exec_attention_items', x.missing is null, x.missing
  from (
    select string_agg(e.name, ', ' order by e.name) as missing
    from unnest(array[
      'exec_attention_items_source_check', 'exec_attention_items_category_check', 'exec_attention_items_score_check',
      'exec_attention_items_band_check', 'exec_attention_items_reasons_check', 'exec_attention_items_facts_check',
      'exec_attention_items_refs_check', 'exec_attention_items_status_check', 'exec_attention_items_resolution_check',
      'exec_attention_items_fingerprint_check', 'exec_attention_items_resolved_check', 'exec_attention_items_snooze_check'
    ]) e(name)
    where not exists (select 1 from pg_constraint k
                      where k.conrelid = 'public.exec_attention_items'::regclass and k.contype = 'c' and k.conname = e.name)
  ) x
  union all
  select 'unique (principal_id, fingerprint): exec_attention_items',
         exists (select 1 from pg_constraint k
                 where k.conrelid = 'public.exec_attention_items'::regclass and k.contype = 'u'
                   and array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                             order by u.ord) = array['principal_id', 'fingerprint']),
         null
  union all
  select 'principal FK, on delete cascade: exec_attention_items',
         exists (select 1 from pg_constraint k
                 where k.conrelid = 'public.exec_attention_items'::regclass and k.contype = 'f'
                   and k.confrelid = 'public.exec_principals'::regclass and k.confdeltype = 'c'
                   and array(select a.attname::text from unnest(k.conkey) a0(attnum)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = a0.attnum) = array['principal_id']),
         null
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def, false), case when x.def is distinct from e.def then coalesce(x.def, '(missing)') end
  from (values
    ('exec_attention_items_feed_idx', 'btree (principal_id, status, priority_score DESC)'),
    ('exec_attention_items_live_scope_idx', 'btree (principal_id, source, kind) WHERE (status <> ''resolved''::text)'),
    ('exec_attention_items_purge_idx', 'btree (resolved_at) WHERE (status = ''resolved''::text)')
  ) e(name, def)
  left join lateral (
    select regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING ', '') as def
    from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = 'public.exec_attention_items'::regclass and ic.relname = e.name
  ) x on true
) checks
order by ok, check_name;
