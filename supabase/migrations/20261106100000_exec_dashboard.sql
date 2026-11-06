-- Executive AI Assistant: P5a (feed feedback, DD text triage, settings).
--   exec_attention_feedback  his thumbs on Needs Attention items (ids and enums only), kept 365 days
--   exec_ddtext_items        one row per DD text item the triage has handled (no text)
--   exec_ddtext_signals      the signals found in it: kind + an AI summary of at most 200 characters
--   exec_settings            + ddtext_enabled (default false), retention_days_ddtext (default 90)
-- Never stores a comment, note or reason. Deleting the DD source row (task hard delete,
-- off-boarding) deletes the derived rows through the typed foreign keys. The summary is also
-- one fact of a ddtext attention row (exec_attention_items, source dd); the app deletes that
-- row once no signal backs it, or once it is past the 14-day liveness window.
-- Security: RLS ON with NO policies; nothing granted to anon/authenticated; service_role only.
-- Idempotent. Apply MANUALLY in the Supabase SQL editor after the P3 and P4 migrations.
-- Creating the foreign keys briefly takes SHARE ROW EXCLUSIVE locks on activity_logs, tasks,
-- users, eod_notes and sod_notes; under contention the 5 s lock_timeout aborts the whole file
-- (nothing applied): rerun it later.
--
-- DD text triage stays off until it is switched on from the Settings page (ddtext_enabled);
-- supabase/scripts/20261106_exec_p5a_disable_ddtext.sql switches it off and removes every
-- stored summary at once if the page is down. The optional index file
-- 20261106100500_optional_activity_logs_created_at_idx.sql speeds up the triage's scan;
-- nothing depends on it.

set local lock_timeout = '5s';

-- Pre-flight: P2a and P2b, and the DD tables this file references. Aborts before changing anything.
do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_settings') is null then
    raise exception 'exec dashboard aborted, nothing changed: apply 20261104100000_exec_foundation.sql first';
  end if;
  if to_regclass('public.exec_attention_items') is null then
    raise exception 'exec dashboard aborted, nothing changed: apply 20261104200000_exec_attention.sql first';
  end if;
  if to_regclass('public.activity_logs') is null or to_regclass('public.eod_notes') is null
     or to_regclass('public.sod_notes') is null or to_regclass('public.tasks') is null then
    raise exception 'exec dashboard aborted, nothing changed: a DD table this migration references is missing';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

alter table public.exec_settings add column if not exists ddtext_enabled boolean not null default false;
alter table public.exec_settings add column if not exists retention_days_ddtext int not null default 90;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.exec_settings'::regclass
                 and conname = 'exec_settings_retention_days_ddtext_check') then
    alter table public.exec_settings add constraint exec_settings_retention_days_ddtext_check
      check (retention_days_ddtext between 1 and 3650);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Feedback
-- ---------------------------------------------------------------------------

create table if not exists public.exec_attention_feedback (
  id           bigint generated always as identity primary key,
  principal_id text not null references public.exec_principals(id) on delete cascade,
  -- No FK: feedback outlives the item (resolved items are purged after 90 days).
  item_id      text not null,
  fingerprint  text not null,
  kind         text not null,
  vote         smallint not null,
  reason       text,
  created_at   timestamptz not null default now(),
  constraint exec_attention_feedback_item_key unique (principal_id, item_id),
  constraint exec_attention_feedback_item_id_check check (item_id ~ '^ea_[0-9a-f]{32}$'),
  constraint exec_attention_feedback_fingerprint_check check (char_length(fingerprint) between 3 and 300),
  constraint exec_attention_feedback_kind_check check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint exec_attention_feedback_vote_check check (vote in (-1, 1)),
  constraint exec_attention_feedback_reason_check check (reason is null or reason in
    ('useful','not_relevant','wrong_priority','already_handled','duplicate','wrong_facts','other')),
  constraint exec_attention_feedback_reason_vote_check check (
    reason is null or (vote = 1 and reason = 'useful') or (vote = -1 and reason <> 'useful'))
);
create index if not exists exec_attention_feedback_principal_idx on public.exec_attention_feedback (principal_id, created_at desc);
create index if not exists exec_attention_feedback_created_idx   on public.exec_attention_feedback (created_at);

-- ---------------------------------------------------------------------------
-- DD text triage: items
-- ---------------------------------------------------------------------------

create table if not exists public.exec_ddtext_items (
  principal_id      text not null references public.exec_principals(id) on delete cascade,
  source_type       text not null,
  source_id         text not null,
  -- Exactly one typed pointer, matching source_type (the pointer CHECK), so the
  -- DD row's deletion takes this row and its signals with it.
  activity_log_id   text references public.activity_logs(id) on delete cascade,
  eod_note_id       text references public.eod_notes(id) on delete cascade,
  sod_note_id       text references public.sod_notes(id) on delete cascade,
  task_id           text references public.tasks(id) on delete cascade,
  author_user_id    text not null references public.users(id) on delete cascade,
  source_created_at timestamptz not null,
  note_date         date,
  outcome           text not null,
  failure           text,
  content_hash      text not null,
  model             text,
  triage_version    text not null,
  triaged_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  constraint exec_ddtext_items_pkey primary key (principal_id, source_type, source_id),
  constraint exec_ddtext_items_source_type_check check (source_type in
    ('comment','status_comment','handoff_note','extension_reason','eod_note','sod_note')),
  constraint exec_ddtext_items_source_id_check check (char_length(source_id) between 1 and 200),
  constraint exec_ddtext_items_pointer_check check ((case
    when source_type = 'eod_note' then eod_note_id is not null and eod_note_id = source_id
         and activity_log_id is null and sod_note_id is null and task_id is null and note_date is not null
    when source_type = 'sod_note' then sod_note_id is not null and sod_note_id = source_id
         and activity_log_id is null and eod_note_id is null and task_id is null and note_date is not null
    else activity_log_id is not null and activity_log_id = source_id
         and eod_note_id is null and sod_note_id is null and task_id is not null and note_date is null
  end) is true),
  constraint exec_ddtext_items_outcome_check check (outcome in ('signals','none','failed','deferred')),
  constraint exec_ddtext_items_failure_check check ((outcome = 'failed') = (failure is not null)
    and (failure is null or failure in ('refusal','truncated','invalid_output','input_too_large'))),
  constraint exec_ddtext_items_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint exec_ddtext_items_model_check check (model is null or char_length(model) between 1 and 64),
  constraint exec_ddtext_items_version_check check (char_length(triage_version) between 1 and 40)
);
create index if not exists exec_ddtext_items_expires_idx  on public.exec_ddtext_items (expires_at);
create index if not exists exec_ddtext_items_deferred_idx on public.exec_ddtext_items (principal_id, source_created_at) where outcome = 'deferred';
create index if not exists exec_ddtext_items_activity_idx on public.exec_ddtext_items (activity_log_id) where activity_log_id is not null;
create index if not exists exec_ddtext_items_eod_idx      on public.exec_ddtext_items (eod_note_id) where eod_note_id is not null;
create index if not exists exec_ddtext_items_sod_idx      on public.exec_ddtext_items (sod_note_id) where sod_note_id is not null;
create index if not exists exec_ddtext_items_task_idx     on public.exec_ddtext_items (task_id) where task_id is not null;
create index if not exists exec_ddtext_items_author_idx   on public.exec_ddtext_items (author_user_id);

-- ---------------------------------------------------------------------------
-- DD text triage: signals
-- ---------------------------------------------------------------------------

create table if not exists public.exec_ddtext_signals (
  principal_id      text not null,
  source_type       text not null,
  source_id         text not null,
  kind              text not null,
  summary           text,
  confidence        text not null,
  -- Copied from the item by the write RPC (the producers read signals alone).
  task_id           text,
  author_user_id    text not null,
  source_created_at timestamptz not null,
  created_at        timestamptz not null default now(),
  constraint exec_ddtext_signals_pkey primary key (principal_id, source_type, source_id, kind),
  constraint exec_ddtext_signals_item_fkey foreign key (principal_id, source_type, source_id)
    references public.exec_ddtext_items (principal_id, source_type, source_id) on delete cascade,
  constraint exec_ddtext_signals_kind_check check (kind in ('blocker','waiting','decision','mention')),
  constraint exec_ddtext_signals_summary_check check (
    (kind = 'mention' and summary is null and confidence = 'deterministic'
       and source_type in ('comment','status_comment'))
    or (kind <> 'mention' and summary is not null and char_length(summary) between 1 and 200
       and confidence in ('high','medium'))),
  constraint exec_ddtext_signals_task_check check (source_type in ('eod_note','sod_note') or task_id is not null)
);
create index if not exists exec_ddtext_signals_task_idx   on public.exec_ddtext_signals (principal_id, task_id) where task_id is not null;
create index if not exists exec_ddtext_signals_recent_idx on public.exec_ddtext_signals (principal_id, source_created_at desc);

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

-- One item and its signals, replaced atomically (re-triage of a resubmitted note
-- replaces its signals). 'source_gone' when the DD row was deleted since the read.
-- The exception block is a subtransaction: on foreign_key_violation nothing of the
-- call survives. A CHECK violation (a bug) raises to the caller.
create or replace function public.exec_ddtext_replace_item(p_principal text, p_item jsonb, p_signals jsonb)
returns text language plpgsql security invoker set search_path = public as $$
declare
  v_type text := p_item->>'source_type';
  v_id   text := p_item->>'source_id';
begin
  if p_principal is null or v_type is null or v_id is null then
    raise exception 'exec_ddtext_replace_item: principal, source_type and source_id are required';
  end if;
  if jsonb_typeof(p_signals) is distinct from 'array' then
    raise exception 'exec_ddtext_replace_item: p_signals must be a json array';
  end if;
  insert into public.exec_ddtext_items as i (principal_id, source_type, source_id, activity_log_id, eod_note_id,
      sod_note_id, task_id, author_user_id, source_created_at, note_date, outcome, failure, content_hash, model,
      triage_version, triaged_at, expires_at)
  values (p_principal, v_type, v_id, p_item->>'activity_log_id', p_item->>'eod_note_id', p_item->>'sod_note_id',
      p_item->>'task_id', p_item->>'author_user_id', (p_item->>'source_created_at')::timestamptz,
      (p_item->>'note_date')::date, p_item->>'outcome', p_item->>'failure', p_item->>'content_hash',
      p_item->>'model', p_item->>'triage_version', now(), (p_item->>'expires_at')::timestamptz)
  on conflict (principal_id, source_type, source_id) do update set
      activity_log_id = excluded.activity_log_id, eod_note_id = excluded.eod_note_id,
      sod_note_id = excluded.sod_note_id, task_id = excluded.task_id, author_user_id = excluded.author_user_id,
      source_created_at = excluded.source_created_at, note_date = excluded.note_date, outcome = excluded.outcome,
      failure = excluded.failure, content_hash = excluded.content_hash, model = excluded.model,
      triage_version = excluded.triage_version, triaged_at = now(), expires_at = excluded.expires_at;
  delete from public.exec_ddtext_signals s
   where s.principal_id = p_principal and s.source_type = v_type and s.source_id = v_id;
  insert into public.exec_ddtext_signals (principal_id, source_type, source_id, kind, summary, confidence,
      task_id, author_user_id, source_created_at)
  select p_principal, v_type, v_id, x->>'kind', x->>'summary', x->>'confidence', p_item->>'task_id',
         p_item->>'author_user_id', (p_item->>'source_created_at')::timestamptz
    from jsonb_array_elements(p_signals) x;
  return 'written';
exception
  when foreign_key_violation then
    return 'source_gone';
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, no policies; service_role only
-- ---------------------------------------------------------------------------

alter table public.exec_attention_feedback enable row level security;
alter table public.exec_ddtext_items       enable row level security;
alter table public.exec_ddtext_signals     enable row level security;
revoke all on public.exec_attention_feedback, public.exec_ddtext_items, public.exec_ddtext_signals
  from public, anon, authenticated;
grant all on public.exec_attention_feedback, public.exec_ddtext_items, public.exec_ddtext_signals to service_role;
do $$ declare s text; begin
  s := pg_get_serial_sequence('public.exec_attention_feedback', 'id');
  if s is null then raise exception 'exec dashboard aborted, rolled back: exec_attention_feedback has no identity column "id"'; end if;
  execute format('revoke all on sequence %s from public, anon, authenticated', s);
  execute format('grant usage, select on sequence %s to service_role', s);
end $$;
revoke all on function public.exec_ddtext_replace_item(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.exec_ddtext_replace_item(text, jsonb, jsonb) to service_role;

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
-- And for this file, the shape the app relies on. `create table if not
-- exists` keeps a table left by an earlier draft as it was, so a missing
-- column, constraint or index shows here instead of failing at runtime:
--   * the two exec_settings columns (type, not null, default) and the
--     retention CHECK;
--   * every column of the three new tables, with type and nullability;
--   * every named CHECK, the unique key and both primary keys by columns;
--   * every foreign key with ON DELETE CASCADE, by columns and target;
--   * every index by its definition (the text after " USING ");
--   * the RPC: SECURITY INVOKER with search_path pinned to public.
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
  select 'column: exec_settings.' || e.col || ' ' || e.typ || ' not null default ' || e.def,
         coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values ('ddtext_enabled', 'boolean', 'false'), ('retention_days_ddtext', 'integer', '90')) e(col, typ, def)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = e.typ and a.attnotnull
             and pg_get_expr(d.adbin, d.adrelid) = e.def as ok,
           format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ' (no default)') as found
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.exec_settings'::regclass and a.attname = e.col and not a.attisdropped
  ) x on true
  union all
  select 'check: exec_settings_retention_days_ddtext_check',
         exists (select 1 from pg_constraint pc
                 where pc.conrelid = 'public.exec_settings'::regclass and pc.contype = 'c'
                   and pc.conname = 'exec_settings_retention_days_ddtext_check'),
         null
  union all
  select 'columns: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_attention_feedback'), ('exec_ddtext_items'), ('exec_ddtext_signals')) e(tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_attention_feedback', 1, 'id', 'bigint', true), ('exec_attention_feedback', 2, 'principal_id', 'text', true),
      ('exec_attention_feedback', 3, 'item_id', 'text', true), ('exec_attention_feedback', 4, 'fingerprint', 'text', true),
      ('exec_attention_feedback', 5, 'kind', 'text', true), ('exec_attention_feedback', 6, 'vote', 'smallint', true),
      ('exec_attention_feedback', 7, 'reason', 'text', false),
      ('exec_attention_feedback', 8, 'created_at', 'timestamp with time zone', true),
      ('exec_ddtext_items', 1, 'principal_id', 'text', true), ('exec_ddtext_items', 2, 'source_type', 'text', true),
      ('exec_ddtext_items', 3, 'source_id', 'text', true), ('exec_ddtext_items', 4, 'activity_log_id', 'text', false),
      ('exec_ddtext_items', 5, 'eod_note_id', 'text', false), ('exec_ddtext_items', 6, 'sod_note_id', 'text', false),
      ('exec_ddtext_items', 7, 'task_id', 'text', false), ('exec_ddtext_items', 8, 'author_user_id', 'text', true),
      ('exec_ddtext_items', 9, 'source_created_at', 'timestamp with time zone', true),
      ('exec_ddtext_items', 10, 'note_date', 'date', false), ('exec_ddtext_items', 11, 'outcome', 'text', true),
      ('exec_ddtext_items', 12, 'failure', 'text', false), ('exec_ddtext_items', 13, 'content_hash', 'text', true),
      ('exec_ddtext_items', 14, 'model', 'text', false), ('exec_ddtext_items', 15, 'triage_version', 'text', true),
      ('exec_ddtext_items', 16, 'triaged_at', 'timestamp with time zone', true),
      ('exec_ddtext_items', 17, 'expires_at', 'timestamp with time zone', true),
      ('exec_ddtext_signals', 1, 'principal_id', 'text', true), ('exec_ddtext_signals', 2, 'source_type', 'text', true),
      ('exec_ddtext_signals', 3, 'source_id', 'text', true), ('exec_ddtext_signals', 4, 'kind', 'text', true),
      ('exec_ddtext_signals', 5, 'summary', 'text', false), ('exec_ddtext_signals', 6, 'confidence', 'text', true),
      ('exec_ddtext_signals', 7, 'task_id', 'text', false), ('exec_ddtext_signals', 8, 'author_user_id', 'text', true),
      ('exec_ddtext_signals', 9, 'source_created_at', 'timestamp with time zone', true),
      ('exec_ddtext_signals', 10, 'created_at', 'timestamp with time zone', true)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select 'checks: ' || e.tbl, x.missing is null, x.missing
  from (values ('exec_attention_feedback'), ('exec_ddtext_items'), ('exec_ddtext_signals')) e(tbl)
  cross join lateral (
    select string_agg(k.name, ', ' order by k.name) as missing
    from (values
      ('exec_attention_feedback', 'exec_attention_feedback_item_id_check'),
      ('exec_attention_feedback', 'exec_attention_feedback_fingerprint_check'),
      ('exec_attention_feedback', 'exec_attention_feedback_kind_check'),
      ('exec_attention_feedback', 'exec_attention_feedback_vote_check'),
      ('exec_attention_feedback', 'exec_attention_feedback_reason_check'),
      ('exec_attention_feedback', 'exec_attention_feedback_reason_vote_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_source_type_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_source_id_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_pointer_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_outcome_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_failure_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_hash_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_model_check'),
      ('exec_ddtext_items', 'exec_ddtext_items_version_check'),
      ('exec_ddtext_signals', 'exec_ddtext_signals_kind_check'),
      ('exec_ddtext_signals', 'exec_ddtext_signals_summary_check'),
      ('exec_ddtext_signals', 'exec_ddtext_signals_task_check')
    ) k(tbl, name)
    where k.tbl = e.tbl
      and not exists (select 1 from pg_constraint pc
                      where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = k.name)
  ) x
  union all
  select e.label, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('unique key: exec_attention_feedback_item_key', 'exec_attention_feedback', 'exec_attention_feedback_item_key', 'u',
     array['principal_id', 'item_id']),
    ('primary key: exec_ddtext_items', 'exec_ddtext_items', 'exec_ddtext_items_pkey', 'p',
     array['principal_id', 'source_type', 'source_id']),
    ('primary key: exec_ddtext_signals', 'exec_ddtext_signals', 'exec_ddtext_signals_pkey', 'p',
     array['principal_id', 'source_type', 'source_id', 'kind'])
  ) e(label, tbl, name, contype, cols)
  left join lateral (
    select k.contype = e.contype and c.cols = e.cols as ok,
           k.contype::text || ' (' || array_to_string(c.cols, ', ') || ')' as found
    from pg_constraint k
    cross join lateral (
      select array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                   order by u.ord) as cols) c
    where k.conrelid = to_regclass('public.' || e.tbl) and k.conname = e.name
  ) x on true
  union all
  select 'FK on delete cascade: ' || e.tbl || ' (' || array_to_string(e.cols, ', ') || ') -> ' || e.ref,
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'f'
                   and k.confrelid = to_regclass('public.' || e.ref) and k.confdeltype = 'c'
                   and array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                             order by u.ord) = e.cols),
         null
  from (values
    ('exec_attention_feedback', array['principal_id'], 'exec_principals'),
    ('exec_ddtext_items', array['principal_id'], 'exec_principals'),
    ('exec_ddtext_items', array['activity_log_id'], 'activity_logs'),
    ('exec_ddtext_items', array['eod_note_id'], 'eod_notes'),
    ('exec_ddtext_items', array['sod_note_id'], 'sod_notes'),
    ('exec_ddtext_items', array['task_id'], 'tasks'),
    ('exec_ddtext_items', array['author_user_id'], 'users'),
    ('exec_ddtext_signals', array['principal_id', 'source_type', 'source_id'], 'exec_ddtext_items')
  ) e(tbl, cols, ref)
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def, false),
         case when not coalesce(x.def = e.def, false) then coalesce(x.def, '(missing)') end
  from (values
    ('exec_attention_feedback', 'exec_attention_feedback_principal_idx', 'btree (principal_id, created_at DESC)'),
    ('exec_attention_feedback', 'exec_attention_feedback_created_idx', 'btree (created_at)'),
    ('exec_ddtext_items', 'exec_ddtext_items_expires_idx', 'btree (expires_at)'),
    ('exec_ddtext_items', 'exec_ddtext_items_deferred_idx', 'btree (principal_id, source_created_at) WHERE (outcome = ''deferred''::text)'),
    ('exec_ddtext_items', 'exec_ddtext_items_activity_idx', 'btree (activity_log_id) WHERE (activity_log_id IS NOT NULL)'),
    ('exec_ddtext_items', 'exec_ddtext_items_eod_idx', 'btree (eod_note_id) WHERE (eod_note_id IS NOT NULL)'),
    ('exec_ddtext_items', 'exec_ddtext_items_sod_idx', 'btree (sod_note_id) WHERE (sod_note_id IS NOT NULL)'),
    ('exec_ddtext_items', 'exec_ddtext_items_task_idx', 'btree (task_id) WHERE (task_id IS NOT NULL)'),
    ('exec_ddtext_items', 'exec_ddtext_items_author_idx', 'btree (author_user_id)'),
    ('exec_ddtext_signals', 'exec_ddtext_signals_task_idx', 'btree (principal_id, task_id) WHERE (task_id IS NOT NULL)'),
    ('exec_ddtext_signals', 'exec_ddtext_signals_recent_idx', 'btree (principal_id, source_created_at DESC)')
  ) e(tbl, name, def)
  left join lateral (
    select substr(pg_get_indexdef(i.indexrelid), strpos(pg_get_indexdef(i.indexrelid), ' USING ') + 7) as def
    from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = to_regclass('public.' || e.tbl) and ic.relname = e.name
  ) x on true
  union all
  select 'security invoker, search_path=public: exec_ddtext_replace_item(text,jsonb,jsonb)', coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (select 1) one
  left join lateral (
    select not p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}'::text[])) as ok,
           case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end
             || ', config ' || coalesce(p.proconfig::text, '(none)') as found
    from pg_proc p
    where p.oid = to_regprocedure('public.exec_ddtext_replace_item(text,jsonb,jsonb)')
  ) x on true
) checks
order by ok, check_name;
