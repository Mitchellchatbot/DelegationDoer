-- Executive AI Assistant — P7b Slack intelligence.
--
--   exec_slack_channel_links  per conversation: the owner's client/project tags (high) and the
--                             channel-name rule's verdict (low), with P3's five verdict columns
--                             generated from them. No Slack text.
--   exec_slack_message_links  per stored Slack message (P7a's exec_slack_messages): DD task, project,
--                             client and email-thread links parsed from DD URLs and DD's own posts.
--                             Ids only.
--   exec_slack_digests        one AI digest per (conversation, local day): a summary and short
--                             highlights/decisions/questions, the ts of the messages it used, counts,
--                             full_day (built after the day ended). No verbatim text, no names.
--                             Blanked when a source message is deleted or an author opts out.
--   exec_messages (P5b)       + consulted_slack_refs, consulted_slack_channels, consulted_private_slack:
--                             which Slack messages, digests and channels an answer drew on, so a
--                             delete, a lost channel or a revoke redacts it (exec_chat_redact_slack).
--   exec_drafts (P4)          + purpose ('reply' | 'client_update'), generated_version, client_update_facts.
--   exec_slack_items (P7a)    + a full-text index for search_slack (no column change).
--
-- Message links cascade from P7a's exec_slack_messages. Channel links and digests cascade only when
-- P7a DELETES the channel row (channel deleted, gone from discovery, the 30-day left TTL, stop
-- reading / revoke / uninstall). P7a's other conversation purges (left, lost access, deny, reinstall)
-- keep the row: the exec.slack-intel-sweep job follows P7a's purge outbox (exec_slack_purge_log) and
-- deletes those digests with exec_slack_intel_forget_channels.
-- Security: RLS ON with NO policies; nothing granted to anon/authenticated; functions are
-- SECURITY INVOKER with a pinned search_path and EXECUTE for service_role only.
-- Idempotent. Apply MANUALLY in the Supabase SQL editor AFTER 20261109100000_exec_slack_reading.sql.
-- Nothing runs until EXEC_ENABLED=true and exec_settings.slack_reading_enabled is turned on.
--
-- This file creates no trigger on, adds no column to, and redefines no function or CHECK of, a P7a table
-- (only the search index of section 7 below); every earlier phase's CHECK is left as it was (the new
-- exec_messages / exec_drafts constraints have new names).

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: refuse, with nothing changed, a database without P2a, P4, P5b, P6 or P7a's final objects.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_jobs') is null then
    raise exception 'exec slack intel aborted, nothing changed: the P2a foundation is missing';
  end if;
  if to_regclass('public.exec_drafts') is null then
    raise exception 'exec slack intel aborted, nothing changed: P4 drafts are missing (apply 20261105200000_exec_drafts.sql first)';
  end if;
  if to_regclass('public.exec_messages') is null
     or to_regprocedure('public.exec_chat_finish_turn(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], text[], boolean, jsonb, text, integer)') is null
     or to_regprocedure('public.exec_chat_redact_message(text, text, text)') is null then
    raise exception 'exec slack intel aborted, nothing changed: P5b chat is missing or older than expected';
  end if;
  if to_regclass('public.exec_slack_installations') is null then
    raise exception 'exec slack intel aborted, nothing changed: P6 Slack is missing';
  end if;
  if to_regclass('public.exec_slack_channels') is null or to_regclass('public.exec_slack_messages') is null
     or to_regclass('public.exec_slack_items') is null or to_regclass('public.exec_slack_deleted') is null
     or to_regclass('public.exec_slack_purge_log') is null or to_regclass('public.exec_slack_author_optouts') is null then
    raise exception 'exec slack intel aborted, nothing changed: P7a Slack reading is missing or older than expected (apply 20261109100000_exec_slack_reading.sql first)';
  end if;
  -- Every P7a column P7b's SQL reads (language sql bodies are validated at CREATE: check them first).
  if (select count(*) from information_schema.columns c
       where c.table_schema = 'public'
         and (c.table_name::text, c.column_name::text) in (
           ('exec_slack_channels', 'conv_type'), ('exec_slack_channels', 'is_private'), ('exec_slack_channels', 'class'),
           ('exec_slack_channels', 'watch_state'), ('exec_slack_channels', 'left_at'), ('exec_slack_channels', 'is_ext_shared'),
           ('exec_slack_channels', 'ext_ever'), ('exec_slack_channels', 'finance_name'),
           ('exec_slack_messages', 'dd_paths'), ('exec_slack_messages', 'is_dd_post'), ('exec_slack_messages', 'author_external'),
           ('exec_slack_items', 'source_class'), ('exec_slack_items', 'bypass_mute'), ('exec_slack_items', 'author_user_id'),
           ('exec_slack_author_optouts', 'author_user_id'), ('exec_slack_author_optouts', 'created_at'),
           ('exec_slack_installations', 'user_revoked_at'), ('exec_slack_installations', 'user_token_enc'))) <> 18 then
    raise exception 'exec slack intel aborted, nothing changed: a P7a column P7b reads is missing (P7a incomplete or older than expected)';
  end if;
  if not exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
                 where t.relname = 'exec_slack_channels' and c.contype in ('p', 'u')
                   and pg_get_constraintdef(c.oid) ~ '\(principal_id, channel_id\)') then
    raise exception 'exec slack intel aborted, nothing changed: exec_slack_channels has no key on (principal_id, channel_id)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. exec_slack_messages.dd_paths is P7a's (written on anchors and candidates alike; no P7b column on P7a's tables).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 2. exec_slack_channel_links (N18, C2, C3)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_channel_links (
  principal_id      text not null,
  channel_id        text not null constraint exec_slack_channel_links_channel_check check (channel_id ~ '^[CGD][A-Z0-9]{2,30}$'),
  -- The owner's tags (the picker). High by definition.
  tag_client_id     text constraint exec_slack_channel_links_tag_client_check
                      check (tag_client_id is null or char_length(tag_client_id) between 1 and 100),
  tag_client_name   text constraint exec_slack_channel_links_tag_name_check
                      check (tag_client_name is null or char_length(tag_client_name) between 1 and 200),
  tag_project_ids   text[] not null default '{}'
                      constraint exec_slack_channel_links_tag_projects_check check (cardinality(tag_project_ids) <= 10),
  tagged_at         timestamptz,
  -- The channel-name rule (correlator). Low by definition; candidates > 1 = ambiguous, no client.
  rule_client_id    text constraint exec_slack_channel_links_rule_client_check
                      check (rule_client_id is null or char_length(rule_client_id) between 1 and 100),
  rule_client_name  text constraint exec_slack_channel_links_rule_name_check
                      check (rule_client_name is null or char_length(rule_client_name) between 1 and 200),
  rule_candidates   integer not null default 0 constraint exec_slack_channel_links_rule_candidates_check
                      check (rule_candidates between 0 and 1000),
  rule_computed_at  timestamptz,
  -- P3's five verdict columns, generated: a tag always wins, and no writer can overwrite one (C2).
  client_id         text generated always as (coalesce(tag_client_id, rule_client_id)) stored,
  client_name       text generated always as (case when tag_client_id is not null then tag_client_name else rule_client_name end) stored,
  client_match_via  text generated always as (case when tag_client_id is not null then 'tag'
                                                   when rule_client_id is not null or rule_candidates > 1 then 'name' end) stored,
  match_confidence  text generated always as (case when tag_client_id is not null then 'high'
                                                   when rule_client_id is not null or rule_candidates > 1 then 'low' end) stored,
  client_candidates integer generated always as (case when tag_client_id is not null then 1 else rule_candidates end) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint exec_slack_channel_links_pkey primary key (principal_id, channel_id),
  constraint exec_slack_channel_links_channel_fkey foreign key (principal_id, channel_id)
    references public.exec_slack_channels (principal_id, channel_id) on delete cascade on update cascade,
  constraint exec_slack_channel_links_tag_pair_check check ((tag_client_id is null) = (tag_client_name is null)),
  constraint exec_slack_channel_links_tagged_at_check
    check ((tagged_at is null) = (tag_client_id is null and cardinality(tag_project_ids) = 0)),
  constraint exec_slack_channel_links_rule_pair_check check ((rule_client_id is null) = (rule_client_name is null)),
  constraint exec_slack_channel_links_rule_shape_check
    check ((rule_client_id is not null and rule_candidates = 1) or (rule_client_id is null and rule_candidates <> 1))
);
create index if not exists exec_slack_channel_links_client_idx
  on public.exec_slack_channel_links (principal_id, client_id) where client_id is not null;
create index if not exists exec_slack_channel_links_projects_idx
  on public.exec_slack_channel_links using gin (tag_project_ids);

-- ---------------------------------------------------------------------------
-- 3. exec_slack_message_links (N18, C5)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_message_links (
  principal_id      text not null,
  channel_id        text not null,
  ts                text not null constraint exec_slack_message_links_ts_check check (ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  client_id         text constraint exec_slack_message_links_client_check check (client_id is null or char_length(client_id) between 1 and 100),
  client_name       text constraint exec_slack_message_links_client_name_check
                      check (client_name is null or char_length(client_name) between 1 and 200),
  client_match_via  text constraint exec_slack_message_links_via_check
                      check (client_match_via is null or client_match_via in ('dd_post', 'dd_link', 'domain')),
  match_confidence  text constraint exec_slack_message_links_confidence_check
                      check (match_confidence is null or match_confidence in ('high', 'medium', 'low')),
  client_candidates integer not null default 0 constraint exec_slack_message_links_candidates_check
                      check (client_candidates between 0 and 1000),
  task_ids          text[] not null default '{}' constraint exec_slack_message_links_tasks_check check (cardinality(task_ids) <= 20),
  project_ids       text[] not null default '{}' constraint exec_slack_message_links_projects_check check (cardinality(project_ids) <= 20),
  email_thread_ids  text[] not null default '{}' constraint exec_slack_message_links_threads_check check (cardinality(email_thread_ids) <= 5),
  checked_at        timestamptz not null default now(),
  constraint exec_slack_message_links_pkey primary key (principal_id, channel_id, ts),
  constraint exec_slack_message_links_message_fkey foreign key (principal_id, channel_id, ts)
    references public.exec_slack_messages (principal_id, channel_id, ts) on delete cascade on update cascade,
  constraint exec_slack_message_links_pair_check check ((client_id is null) = (client_name is null)),
  -- Null-safe on purpose: a CHECK passes on NULL, so a confidence without a via (or a via without a confidence) must make
  -- every arm FALSE, not NULL.
  constraint exec_slack_message_links_verdict_check check (
    (client_match_via is null and match_confidence is null)
    or (client_match_via is not null and match_confidence is not null and (
         (client_match_via in ('dd_post', 'dd_link') and match_confidence = 'high' and client_id is not null and client_candidates = 1)
         or (client_match_via = 'domain' and ((match_confidence = 'medium' and client_id is not null and client_candidates = 1)
                                              or (match_confidence = 'low' and client_candidates >= 1))))))
);
create index if not exists exec_slack_message_links_tasks_idx on public.exec_slack_message_links using gin (task_ids);
create index if not exists exec_slack_message_links_projects_idx on public.exec_slack_message_links using gin (project_ids);
create index if not exists exec_slack_message_links_client_idx
  on public.exec_slack_message_links (principal_id, client_id) where client_id is not null;

-- ---------------------------------------------------------------------------
-- 4. exec_slack_digests (N19, C6, C12-C15)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_digests (
  id                  text primary key default ('esd_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id        text not null,
  channel_id          text not null,
  local_date          date not null,
  tz                  text not null constraint exec_slack_digests_tz_check check (char_length(tz) between 1 and 64),
  from_ts             text not null constraint exec_slack_digests_from_check check (from_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  to_ts               text not null constraint exec_slack_digests_to_check check (to_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  status              text not null constraint exec_slack_digests_status_check
                        check (status in ('building', 'built', 'empty', 'stale', 'failed', 'skipped_cap')),
  -- AI text only (no excerpt, no names, verbatim runs clipped in code, C12).
  summary             text constraint exec_slack_digests_summary_check check (summary is null or char_length(summary) between 1 and 1200),
  highlights          jsonb not null default '[]'::jsonb constraint exec_slack_digests_highlights_check
                        check (jsonb_typeof(highlights) = 'array' and jsonb_array_length(highlights) <= 6),
  decisions           jsonb not null default '[]'::jsonb constraint exec_slack_digests_decisions_check
                        check (jsonb_typeof(decisions) = 'array' and jsonb_array_length(decisions) <= 6),
  open_questions      jsonb not null default '[]'::jsonb constraint exec_slack_digests_questions_check
                        check (jsonb_typeof(open_questions) = 'array' and jsonb_array_length(open_questions) <= 6),
  -- Every message ts the model saw: a delete of any of them blanks the digest (N13).
  source_ts           text[] not null default '{}' constraint exec_slack_digests_source_check check (cardinality(source_ts) <= 2000),
  human_count         integer not null default 0 constraint exec_slack_digests_human_check check (human_count >= 0),
  bot_count           integer not null default 0 constraint exec_slack_digests_bot_check check (bot_count >= 0),
  dd_post_count       integer not null default 0 constraint exec_slack_digests_dd_check check (dd_post_count >= 0),
  external_count      integer not null default 0 constraint exec_slack_digests_external_check check (external_count >= 0),
  thread_count        integer not null default 0 constraint exec_slack_digests_thread_check check (thread_count >= 0),
  privacy             text constraint exec_slack_digests_privacy_check
                        check (privacy is null or privacy in ('public', 'private', 'group_dm', 'external', 'finance')),
  partial             boolean not null default false,
  -- True only when the history was read after the local day ended (plan and rebuild builds of a past day);
  -- a "today so far" build is false, so the 00:30 plan finishes it (C15).
  full_day            boolean not null default false,
  injection_suspected boolean not null default false,
  rebuilds            integer not null default 0 constraint exec_slack_digests_rebuilds_check check (rebuilds between 0 and 1000),
  model               text constraint exec_slack_digests_model_check check (model is null or char_length(model) <= 64),
  cost_usd            numeric(10, 4) constraint exec_slack_digests_cost_check check (cost_usd is null or cost_usd >= 0),
  requested_at        timestamptz not null default now(),
  built_at            timestamptz,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  search_tsv          tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(summary, ''))) stored,
  constraint exec_slack_digests_day_key unique (principal_id, channel_id, local_date),
  constraint exec_slack_digests_channel_fkey foreign key (principal_id, channel_id)
    references public.exec_slack_channels (principal_id, channel_id) on delete cascade on update cascade,
  -- Whitelist: only a built digest holds text; built needs a summary and a source list.
  constraint exec_slack_digests_content_check check (
    (status = 'built' and summary is not null and cardinality(source_ts) >= 1 and built_at is not null)
    or (status <> 'built' and summary is null and highlights = '[]'::jsonb and decisions = '[]'::jsonb
        and open_questions = '[]'::jsonb)),
  constraint exec_slack_digests_sources_check check (status in ('built', 'empty') or cardinality(source_ts) = 0),
  constraint exec_slack_digests_full_day_check check (not full_day or status in ('built', 'empty')),
  -- A cheap sanity check only: ts strings of different lengths don't compare lexically, so the check passes them;
  -- code compares with compareTs.
  constraint exec_slack_digests_range_check check (from_ts <= to_ts or length(from_ts) <> length(to_ts))
);
create index if not exists exec_slack_digests_date_idx on public.exec_slack_digests (principal_id, local_date desc);
create index if not exists exec_slack_digests_building_idx on public.exec_slack_digests (requested_at) where status = 'building';
create index if not exists exec_slack_digests_expires_idx on public.exec_slack_digests (expires_at);
create index if not exists exec_slack_digests_search_idx on public.exec_slack_digests using gin (search_tsv);

-- ---------------------------------------------------------------------------
-- 5. exec_messages (P5b) additions (N15). New constraint names only: P5b's own CHECKs are left untouched.
-- ---------------------------------------------------------------------------

alter table public.exec_messages add column if not exists consulted_slack_refs text[] not null default '{}';
alter table public.exec_messages add column if not exists consulted_slack_channels text[] not null default '{}';
alter table public.exec_messages add column if not exists consulted_private_slack boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_messages'::regclass and conname = 'exec_messages_slack_refs_check') then
    alter table public.exec_messages add constraint exec_messages_slack_refs_check
      check (cardinality(consulted_slack_refs) <= 600);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_messages'::regclass and conname = 'exec_messages_slack_channels_check') then
    alter table public.exec_messages add constraint exec_messages_slack_channels_check
      check (cardinality(consulted_slack_channels) <= 200);
  end if;
  -- A question carries none of it (the sibling of P5b's exec_messages_user_row_check, which is left untouched).
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_messages'::regclass and conname = 'exec_messages_user_row_slack_check') then
    alter table public.exec_messages add constraint exec_messages_user_row_slack_check
      check (role = 'assistant' or (cardinality(consulted_slack_refs) = 0 and cardinality(consulted_slack_channels) = 0
                                    and not consulted_private_slack));
  end if;
  -- Every channel of a ref is also in the channel list (the revoke and lost-channel arms key on it).
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_messages'::regclass and conname = 'exec_messages_slack_pair_check') then
    alter table public.exec_messages add constraint exec_messages_slack_pair_check
      check (cardinality(consulted_slack_refs) = 0 or cardinality(consulted_slack_channels) >= 1);
  end if;
end $$;
create index if not exists exec_messages_slack_refs_idx on public.exec_messages using gin (consulted_slack_refs);
create index if not exists exec_messages_slack_channels_idx on public.exec_messages using gin (consulted_slack_channels);
create index if not exists exec_messages_slack_any_idx
  on public.exec_messages (principal_id) where cardinality(consulted_slack_channels) > 0;

-- Ref key formats (code builds them only through slack-intel-types.ts' helpers): message m:<channelId>:<ts>;
-- digest d:<channelId>:<YYYY-MM-DD>:<rebuilds>.

-- ---------------------------------------------------------------------------
-- 6. exec_drafts (P4) additions (N17, C9, C10). New constraint names only.
-- ---------------------------------------------------------------------------

alter table public.exec_drafts add column if not exists purpose text not null default 'reply';
alter table public.exec_drafts add column if not exists generated_version integer;
alter table public.exec_drafts add column if not exists client_update_facts jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_drafts'::regclass and conname = 'exec_drafts_purpose_check') then
    alter table public.exec_drafts add constraint exec_drafts_purpose_check check (purpose in ('reply', 'client_update'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_drafts'::regclass and conname = 'exec_drafts_purpose_kind_check') then
    alter table public.exec_drafts add constraint exec_drafts_purpose_kind_check check (purpose = 'reply' or kind = 'reply');
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_drafts'::regclass and conname = 'exec_drafts_generated_version_check') then
    alter table public.exec_drafts add constraint exec_drafts_generated_version_check
      check (generated_version is null or generated_version between 1 and version);
  end if;
  -- Counts and slot statuses only (ClientUpdateFactsRecord); never text.
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_drafts'::regclass and conname = 'exec_drafts_client_update_facts_check') then
    alter table public.exec_drafts add constraint exec_drafts_client_update_facts_check
      check (client_update_facts is null or (jsonb_typeof(client_update_facts) = 'object' and purpose = 'client_update'
                                             and pg_column_size(client_update_facts) <= 2048));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. The search index on P7a's items (no column change).
-- ---------------------------------------------------------------------------

create index if not exists exec_slack_items_search_idx on public.exec_slack_items
  using gin (to_tsvector('simple'::regconfig, coalesce(summary, '') || ' ' || coalesce(excerpt, '')));

-- ---------------------------------------------------------------------------
-- 8. RPCs 1-8, 13, 14: links, project rows, search, digests, public facts, forgetting
-- ---------------------------------------------------------------------------

-- RPC 1. The owner's tags (C25). 'ok' | 'not_found' | 'not_taggable'. The channel row is locked so a
-- concurrent purge can't race the insert (the FK would refuse it anyway).
drop function if exists public.exec_slack_set_channel_links(text, text, text, text, text[]);
create or replace function public.exec_slack_set_channel_links(
  p_principal text, p_channel_id text, p_client_id text, p_client_name text, p_project_ids text[]
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_ch  record;
  v_now timestamptz := now();
begin
  if p_project_ids is null or cardinality(p_project_ids) > 10 then
    raise exception 'exec_slack_set_channel_links: bad project ids';
  end if;
  if (p_client_id is null) <> (p_client_name is null) then
    raise exception 'exec_slack_set_channel_links: client id and name go together';
  end if;
  select c.class, c.conv_type, c.watch_state, c.left_at into v_ch
    from public.exec_slack_channels c
   where c.principal_id = p_principal and c.channel_id = p_channel_id
   for update;
  if not found then return 'not_found'; end if;
  -- C25: P7a's classes; a muted channel can be tagged, an unwatched or left one can't (nothing of it is read).
  if v_ch.class not in ('standard', 'external', 'finance') or v_ch.conv_type = 'im'
     or v_ch.watch_state = 'unwatched' or v_ch.left_at is not null then
    return 'not_taggable';
  end if;
  insert into public.exec_slack_channel_links
    (principal_id, channel_id, tag_client_id, tag_client_name, tag_project_ids, tagged_at, created_at, updated_at)
  values (p_principal, p_channel_id, p_client_id, p_client_name, p_project_ids,
          case when p_client_id is null and cardinality(p_project_ids) = 0 then null else v_now end, v_now, v_now)
  on conflict (principal_id, channel_id) do update
     set tag_client_id = excluded.tag_client_id, tag_client_name = excluded.tag_client_name,
         tag_project_ids = excluded.tag_project_ids, tagged_at = excluded.tagged_at, updated_at = v_now;
  return 'ok';
end;
$$;

-- RPC 2. The correlator's rule verdicts (C2, C3), rule_* columns only; channels that no longer exist are
-- skipped; unchanged rows aren't rewritten. Returns the rows written.
drop function if exists public.exec_slack_set_channel_rules(text, jsonb);
create or replace function public.exec_slack_set_channel_rules(p_principal text, p_rows jsonb)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare n integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'exec_slack_set_channel_rules: rows must be an array of at most 2000';
  end if;
  insert into public.exec_slack_channel_links
    (principal_id, channel_id, rule_client_id, rule_client_name, rule_candidates, rule_computed_at, created_at, updated_at)
  select p_principal, r.channel_id, r.client_id, r.client_name, coalesce(r.candidates, 0), now(), now(), now()
    from jsonb_to_recordset(p_rows) as r(channel_id text, client_id text, client_name text, candidates integer)
    join public.exec_slack_channels c on c.principal_id = p_principal and c.channel_id = r.channel_id
  on conflict (principal_id, channel_id) do update
     set rule_client_id = excluded.rule_client_id, rule_client_name = excluded.rule_client_name,
         rule_candidates = excluded.rule_candidates, rule_computed_at = excluded.rule_computed_at, updated_at = now()
   where (public.exec_slack_channel_links.rule_client_id, public.exec_slack_channel_links.rule_client_name,
          public.exec_slack_channel_links.rule_candidates)
         is distinct from (excluded.rule_client_id, excluded.rule_client_name, excluded.rule_candidates)
      or public.exec_slack_channel_links.rule_computed_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- RPC 3. P7a message rows with no link row yet (C5), oldest first, with their P7a-written dd_paths (anchors and
-- candidates/items alike) and the AI summaries of their items (the domain signal reads summaries only: excerpts
-- stay in P7a's table, B-P7b-3).
drop function if exists public.exec_slack_unlinked_messages(text, integer);
create or replace function public.exec_slack_unlinked_messages(p_principal text, p_limit integer)
returns table (channel_id text, ts text, thread_ts text, role text, is_dd_post boolean, dd_paths text[], summaries text[])
language sql stable security invoker set search_path = '' as $$
  select m.channel_id, m.ts, m.thread_ts, m.role, m.is_dd_post, m.dd_paths,
         coalesce((select array_agg(i.summary) from public.exec_slack_items i
                    where i.principal_id = m.principal_id and i.channel_id = m.channel_id and i.ts = m.ts
                      and i.summary is not null), '{}'::text[])
    from public.exec_slack_messages m
   where m.principal_id = p_principal
     and not exists (select 1 from public.exec_slack_message_links l
                      where l.principal_id = m.principal_id and l.channel_id = m.channel_id and l.ts = m.ts)
   order by m.created_at, m.channel_id, m.ts
   limit least(greatest(coalesce(p_limit, 500), 1), 2000)
$$;

-- RPC 4. The "Linked to this project's work" item ids (C19): message links to the project or its tasks,
-- replies in those threads, and items in channels tagged to the project. An item's time is its message ts
-- (P7a has no occurred_at). Code re-screens every row (getSlackItemsByIds + slackItemPolicy), so it asks for
-- three times the rows it shows.
drop function if exists public.exec_slack_project_items(text, text, text[], timestamptz, integer);
create or replace function public.exec_slack_project_items(
  p_principal text, p_project_id text, p_task_ids text[], p_since timestamptz, p_limit integer
) returns table (item_id text, via text, at timestamptz)
language sql stable security invoker set search_path = '' as $$
  with keys as (
    select l.channel_id, l.ts from public.exec_slack_message_links l
     where l.principal_id = p_principal
       and (l.project_ids @> array[p_project_id] or l.task_ids && coalesce(p_task_ids, '{}'::text[]))
  ), tagged as (
    select cl.channel_id from public.exec_slack_channel_links cl
     where cl.principal_id = p_principal and cl.tag_project_ids @> array[p_project_id]
  ), hits as (
    select i.id, 'link'::text as via, to_timestamp(i.ts::numeric) as at from public.exec_slack_items i
      join keys k on k.channel_id = i.channel_id and k.ts = i.ts
     where i.principal_id = p_principal and to_timestamp(i.ts::numeric) >= p_since
    union all
    select i.id, 'thread', to_timestamp(i.ts::numeric) from public.exec_slack_items i
      join keys k on k.channel_id = i.channel_id and k.ts = i.thread_ts
     where i.principal_id = p_principal and to_timestamp(i.ts::numeric) >= p_since
       and i.thread_ts is not null and i.thread_ts <> i.ts
    union all
    select i.id, 'tag', to_timestamp(i.ts::numeric) from public.exec_slack_items i
      join tagged t on t.channel_id = i.channel_id
     where i.principal_id = p_principal and to_timestamp(i.ts::numeric) >= p_since
  ), one as (
    select distinct on (h.id) h.id, h.via, h.at from hits h
     order by h.id, case h.via when 'link' then 0 when 'thread' then 1 else 2 end
  )
  select o.id, o.via, o.at from one o
   order by o.at desc, o.id
   limit least(greatest(coalesce(p_limit, 30), 1), 150)
$$;

-- RPC 5. Stored search (N16): P7a's items (summary + excerpt, matched in SQL, never returned) and built
-- digests (summary), restricted to the channels the caller's policy allowed: p_channel_ids are watched channels
-- (every item, and digests); p_bypass_channel_ids are owner- or Slack-muted, non-finance channels whose items show
-- only with bypass_mute on the page and in chat (C7, P7a's final C20; never digests). An empty query ranks by time.
-- A digest requested at or before the newest per-author opt-out is left out until the sweep blanks it (digests store
-- no author, C33; fixer security-3).
drop function if exists public.exec_slack_search(text, text, text[], text[], text[], timestamptz, boolean, integer);
create or replace function public.exec_slack_search(
  p_principal text, p_query text, p_channel_ids text[], p_bypass_channel_ids text[], p_kinds text[], p_since timestamptz,
  p_include_digests boolean, p_limit integer
) returns table (src text, id text, channel_id text, rank real, at timestamptz)
language sql stable security invoker set search_path = '' as $$
  with q as (select websearch_to_tsquery('simple'::regconfig, coalesce(p_query, '')) as tq)
  select * from (
    select 'item'::text, i.id, i.channel_id,
           ts_rank(to_tsvector('simple'::regconfig, coalesce(i.summary, '') || ' ' || coalesce(i.excerpt, '')), q.tq),
           to_timestamp(i.ts::numeric)
      from public.exec_slack_items i, q
     where i.principal_id = p_principal
       and (i.channel_id = any (coalesce(p_channel_ids, '{}'::text[]))
            or (i.bypass_mute and i.channel_id = any (coalesce(p_bypass_channel_ids, '{}'::text[]))))
       and to_timestamp(i.ts::numeric) >= p_since and (p_kinds is null or i.kind = any (p_kinds))
       and (numnode(q.tq) = 0
            or to_tsvector('simple'::regconfig, coalesce(i.summary, '') || ' ' || coalesce(i.excerpt, '')) @@ q.tq)
    union all
    select 'digest'::text, d.id, d.channel_id, ts_rank(d.search_tsv, q.tq), d.built_at
      from public.exec_slack_digests d, q
     where coalesce(p_include_digests, false) and p_kinds is null
       and d.principal_id = p_principal and d.status = 'built'
       and d.channel_id = any (coalesce(p_channel_ids, '{}'::text[])) and d.built_at >= p_since
       and d.requested_at > coalesce((select max(o.created_at) from public.exec_slack_author_optouts o
                                       where o.principal_id = p_principal), '-infinity'::timestamptz)
       and (numnode(q.tq) = 0 or d.search_tsv @@ q.tq)
  ) r (src, id, channel_id, rank, at)
  order by r.rank desc, r.at desc, r.id
  limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;

-- RPC 6. Claim a digest build (C15). Outcomes: claimed (with id and rebuilds), fresh (nothing to do),
-- busy (another build runs), not_found (no channel row). A 'building' row older than 10 minutes is reclaimed.
-- plan / rebuild (a past day's full build): also reclaim a built or empty row that isn't full_day (a "today so
-- far" build) and a skipped_cap row; today: reclaim a built or empty row older than an hour. Every mode reclaims
-- stale, failed, skipped_cap and stale-building rows. A claim never changes rebuilds (only a blank or a
-- deleted_source finish bumps it), so a today rebuild doesn't look like a removal to RPC 11.
drop function if exists public.exec_slack_digest_claim(text, text, date, text, text, text, timestamptz, text);
create or replace function public.exec_slack_digest_claim(
  p_principal text, p_channel_id text, p_local_date date, p_tz text, p_from_ts text, p_to_ts text,
  p_expires_at timestamptz, p_mode text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v   record;
  v_now timestamptz := now();
begin
  if p_mode is null or p_mode not in ('plan', 'today', 'rebuild') then
    raise exception 'exec_slack_digest_claim: bad mode %', coalesce(p_mode, '<NULL>');
  end if;
  perform 1 from public.exec_slack_channels c where c.principal_id = p_principal and c.channel_id = p_channel_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  insert into public.exec_slack_digests (principal_id, channel_id, local_date, tz, from_ts, to_ts, status, requested_at, expires_at)
  values (p_principal, p_channel_id, p_local_date, p_tz, p_from_ts, p_to_ts, 'building', v_now, p_expires_at)
  on conflict (principal_id, channel_id, local_date) do nothing
  returning id, rebuilds into v;
  if found then return jsonb_build_object('outcome', 'claimed', 'id', v.id, 'rebuilds', v.rebuilds); end if;

  select d.id, d.status, d.built_at, d.requested_at, d.rebuilds, d.full_day into v
    from public.exec_slack_digests d
   where d.principal_id = p_principal and d.channel_id = p_channel_id and d.local_date = p_local_date
   for update;
  if v.status = 'building' and v.requested_at > v_now - interval '10 minutes' then
    return jsonb_build_object('outcome', 'busy');
  end if;
  if not (v.status in ('stale', 'failed', 'skipped_cap', 'building')
          or (p_mode in ('plan', 'rebuild') and v.status in ('built', 'empty') and not v.full_day)
          or (p_mode = 'today' and v.status in ('built', 'empty')
              and coalesce(v.built_at, v.requested_at) < v_now - interval '1 hour')) then
    return jsonb_build_object('outcome', 'fresh');
  end if;
  update public.exec_slack_digests d
     set status = 'building', summary = null, highlights = '[]'::jsonb, decisions = '[]'::jsonb, open_questions = '[]'::jsonb,
         source_ts = '{}'::text[], full_day = false, tz = p_tz, from_ts = p_from_ts, to_ts = p_to_ts, requested_at = v_now,
         expires_at = p_expires_at, updated_at = v_now
   where d.id = v.id;
  return jsonb_build_object('outcome', 'claimed', 'id', v.id, 'rebuilds', v.rebuilds);
end;
$$;

-- RPC 7. Finish a build. 'ok' | 'lost' (no longer building: blanked or reclaimed meanwhile) |
-- 'channel_gone' (the channel was left, lost or reclassified deny/hub/unclassified while the model wrote: the row is
-- deleted, nothing is stored, N1/N13) | 'deleted_source' (a message it used now has a deleted marker or a message
-- purge-outbox row, or an author opted out since the build started: the row goes stale with no text; the
-- resurrection guard of N7, under the row lock).
drop function if exists public.exec_slack_digest_finish(text, text, text, text, jsonb, jsonb, jsonb, text[], jsonb, text, boolean, boolean, text, numeric, boolean);
create or replace function public.exec_slack_digest_finish(
  p_principal text, p_id text, p_status text, p_summary text, p_highlights jsonb, p_decisions jsonb, p_questions jsonb,
  p_source_ts text[], p_counts jsonb, p_privacy text, p_partial boolean, p_injection boolean, p_model text, p_cost numeric,
  p_full_day boolean
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v     record;
  v_now timestamptz := now();
begin
  if p_status is null or p_status not in ('built', 'empty', 'failed', 'skipped_cap') then
    raise exception 'exec_slack_digest_finish: bad status %', coalesce(p_status, '<NULL>');
  end if;
  select d.id, d.channel_id, d.status, d.requested_at into v from public.exec_slack_digests d
   where d.id = p_id and d.principal_id = p_principal for update;
  if not found or v.status <> 'building' then return 'lost'; end if;
  if not exists (select 1 from public.exec_slack_channels c
                  where c.principal_id = p_principal and c.channel_id = v.channel_id
                    and c.class in ('standard', 'external', 'finance') and c.left_at is null) then
    delete from public.exec_slack_digests d where d.id = v.id;
    return 'channel_gone';
  end if;
  if p_status in ('built', 'empty') and (
       exists (select 1 from public.exec_slack_deleted x
                where x.principal_id = p_principal and x.channel_id = v.channel_id
                  and x.ts = any (coalesce(p_source_ts, '{}'::text[])))
       or exists (select 1 from public.exec_slack_purge_log pl
                   where pl.principal_id = p_principal and pl.scope = 'message' and pl.channel_id = v.channel_id
                     and pl.ts = any (coalesce(p_source_ts, '{}'::text[])) and pl.created_at >= v.requested_at)
       or exists (select 1 from public.exec_slack_author_optouts o
                   where o.principal_id = p_principal and o.created_at >= v.requested_at)) then
    update public.exec_slack_digests d
       set status = 'stale', summary = null, highlights = '[]'::jsonb, decisions = '[]'::jsonb, open_questions = '[]'::jsonb,
           source_ts = '{}'::text[], full_day = false, rebuilds = least(d.rebuilds + 1, 1000), updated_at = v_now
     where d.id = v.id;
    return 'deleted_source';
  end if;
  update public.exec_slack_digests d
     set status = p_status,
         summary = case when p_status = 'built' then p_summary end,
         highlights = case when p_status = 'built' then coalesce(p_highlights, '[]'::jsonb) else '[]'::jsonb end,
         decisions = case when p_status = 'built' then coalesce(p_decisions, '[]'::jsonb) else '[]'::jsonb end,
         open_questions = case when p_status = 'built' then coalesce(p_questions, '[]'::jsonb) else '[]'::jsonb end,
         source_ts = case when p_status in ('built', 'empty') then coalesce(p_source_ts, '{}'::text[]) else '{}'::text[] end,
         human_count = coalesce((p_counts ->> 'human')::integer, 0), bot_count = coalesce((p_counts ->> 'bot')::integer, 0),
         dd_post_count = coalesce((p_counts ->> 'ddPost')::integer, 0),
         external_count = coalesce((p_counts ->> 'external')::integer, 0),
         thread_count = coalesce((p_counts ->> 'threads')::integer, 0),
         privacy = p_privacy, partial = coalesce(p_partial, false), injection_suspected = coalesce(p_injection, false),
         full_day = p_status in ('built', 'empty') and coalesce(p_full_day, false),
         model = p_model, cost_usd = p_cost, built_at = v_now, updated_at = v_now
   where d.id = v.id;
  return 'ok';
end;
$$;

-- RPC 8. Blank digests (N13): on a delete, every digest of the channel on the given dates whose sources hold one
-- of the ts, plus any build in flight there (its finish then returns 'lost'); with p_all (an author opt-out, C33),
-- every built, empty or building digest of the principal. Returns what it blanked with the rebuilds value BEFORE
-- the bump (the chat digest keys to redact).
drop function if exists public.exec_slack_digest_blank(text, text, text[], date[], boolean);
create or replace function public.exec_slack_digest_blank(p_principal text, p_channel_id text, p_ts text[], p_dates date[],
                                                          p_all boolean)
returns table (id text, channel_id text, local_date date, old_rebuilds integer)
language plpgsql security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  v_all boolean := coalesce(p_all, false);
begin
  if not v_all and (p_channel_id is null or p_ts is null or cardinality(p_ts) = 0 or cardinality(p_ts) > 500
                    or p_dates is null or cardinality(p_dates) > 30) then
    raise exception 'exec_slack_digest_blank: a channel, 1..500 ts and at most 30 dates, or p_all';
  end if;
  return query
  with hit as (
    select d.id as hid, d.rebuilds as r from public.exec_slack_digests d
     where d.principal_id = p_principal
       and ((v_all and d.status in ('built', 'empty', 'building'))
            or (not v_all and d.channel_id = p_channel_id and d.local_date = any (p_dates)
                and (d.source_ts && p_ts or d.status = 'building')))
     for update
  )
  update public.exec_slack_digests d
     set status = 'stale', summary = null, highlights = '[]'::jsonb, decisions = '[]'::jsonb, open_questions = '[]'::jsonb,
         source_ts = '{}'::text[], full_day = false, rebuilds = least(d.rebuilds + 1, 1000), updated_at = now()
    from hit
   where d.id = hit.hid
  returning d.id, d.channel_id, d.local_date, hit.r;
end;
$$;

-- RPC 13 (used by Area E). The public_slack slot's candidates (N17, C26): item summaries and digest
-- decisions/highlights for one client, from public (conv_type 'channel', not private), standard, watched, never-shared,
-- not finance-named, not left channels; items must carry P7a's source_class 'public' (derived in SQL by P7a and
-- reconciled on reclassification) and need a high link to the client (channel tag or message/thread-root record
-- link); digests a high CHANNEL link. Human messages only (no DD posts, no external authors, no opted-out author),
-- no deleted source. An item's time is its message ts. Code re-checks every row with slackUsePolicy(…, "draft") at
-- generation. Fixer security-5: a digest the model flagged injection_suspected never feeds a draft; fixer security-3: nor
-- does one requested at or before the newest per-author opt-out (digests store no author, C33).
drop function if exists public.exec_slack_public_facts(text, text, timestamptz, integer);
create or replace function public.exec_slack_public_facts(p_principal text, p_client_id text, p_since timestamptz, p_limit integer)
returns table (src text, id text, channel_id text, ts text, local_date date, kind text, body text, at timestamptz)
language sql stable security invoker set search_path = '' as $$
  with ok_channels as (
    select c.channel_id from public.exec_slack_channels c
     where c.principal_id = p_principal and c.conv_type = 'channel' and not c.is_private
       and c.class = 'standard' and c.watch_state = 'watched' and c.left_at is null
       and not c.is_ext_shared and not c.ext_ever and not c.finance_name
  ), high_channels as (
    select l.channel_id from public.exec_slack_channel_links l join ok_channels o using (channel_id)
     where l.principal_id = p_principal and l.client_id = p_client_id and l.match_confidence = 'high'
  ), items as (
    select 'item'::text as src, i.id, i.channel_id, i.ts, null::date as local_date, i.kind, i.summary as body,
           to_timestamp(i.ts::numeric) as at
      from public.exec_slack_items i
      join ok_channels o on o.channel_id = i.channel_id
      join public.exec_slack_messages m on m.principal_id = i.principal_id and m.channel_id = i.channel_id and m.ts = i.ts
     where i.principal_id = p_principal and to_timestamp(i.ts::numeric) >= p_since and i.summary is not null
       and i.source_class = 'public' and i.assessed
       and i.kind in ('decision', 'commitment', 'action_item', 'fyi')
       and not i.author_external and not m.is_dd_post and not m.author_external
       and not exists (select 1 from public.exec_slack_deleted x
                        where x.principal_id = i.principal_id and x.channel_id = i.channel_id and x.ts = i.ts)
       and not exists (select 1 from public.exec_slack_author_optouts oo
                        where oo.principal_id = i.principal_id and oo.author_user_id = i.author_user_id)
       and (i.channel_id in (select channel_id from high_channels)
            or exists (select 1 from public.exec_slack_message_links ml
                        where ml.principal_id = i.principal_id and ml.channel_id = i.channel_id
                          and ml.ts in (i.ts, coalesce(i.thread_ts, i.ts))
                          and ml.client_id = p_client_id and ml.match_confidence = 'high'))
  ), digest_entries as (
    select 'digest'::text, d.id, d.channel_id, null::text, d.local_date, e.kind, e.body, d.built_at
      from public.exec_slack_digests d
      join high_channels h on h.channel_id = d.channel_id
      cross join lateral (
        select 'decision'::text as kind, x.e ->> 'text' as body from jsonb_array_elements(d.decisions) as x(e)
        union all
        select 'fyi'::text, x.e ->> 'text' from jsonb_array_elements(d.highlights) as x(e)
      ) e
     where d.principal_id = p_principal and d.status = 'built' and d.privacy = 'public' and not d.injection_suspected
       and d.requested_at > coalesce((select max(o.created_at) from public.exec_slack_author_optouts o
                                       where o.principal_id = p_principal), '-infinity'::timestamptz)
       and d.local_date >= (p_since at time zone 'UTC')::date and e.body is not null
  )
  select * from (select * from items union all select * from digest_entries) r
   order by r.at desc, r.id
   limit least(greatest(coalesce(p_limit, 8), 1), 20)
$$;

-- RPC 14. Forget conversations (N1, N13, C32). For every listed channel (the sweep's `conversation` outbox rows,
-- reason <> 'rekey') and, with p_scan, every channel whose row is now deny/hub/unclassified or left and still has
-- P7b rows: delete ALL its digests (never blanked: nothing derived from a left, lost or never-watch conversation
-- stays stored), and delete its channel-link row when the channel row is missing or its class is deny or hub (an
-- owner tag survives a leave or a pending reclassification: it describes the channel, not its messages). Message
-- links need nothing: they cascade from P7a's message rows. Returns one row per channel acted on; the caller then
-- redacts chat by channel (RPC 10).
drop function if exists public.exec_slack_intel_forget_channels(text, text[], boolean);
create or replace function public.exec_slack_intel_forget_channels(p_principal text, p_channel_ids text[], p_scan boolean)
returns table (channel_id text, digests integer, links integer)
language plpgsql security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  v_ids text[] := coalesce(p_channel_ids, '{}'::text[]);
  v_c   text;
  v_d   integer;
  v_l   integer;
begin
  if p_principal is null then return; end if;
  if cardinality(v_ids) > 500 then raise exception 'exec_slack_intel_forget_channels: at most 500 channels'; end if;
  if coalesce(p_scan, false) then
    v_ids := v_ids || coalesce((
      select array_agg(x.cid) from (
        select d.channel_id as cid from public.exec_slack_digests d
          join public.exec_slack_channels c on c.principal_id = d.principal_id and c.channel_id = d.channel_id
         where d.principal_id = p_principal
           and (c.class in ('deny', 'hub', 'unclassified') or c.left_at is not null)
        union
        select l.channel_id from public.exec_slack_channel_links l
          join public.exec_slack_channels c on c.principal_id = l.principal_id and c.channel_id = l.channel_id
         where l.principal_id = p_principal and c.class in ('deny', 'hub')
        limit 500) x), '{}'::text[]);
  end if;
  foreach v_c in array coalesce((select array_agg(distinct u.c) from unnest(v_ids) as u(c)), '{}'::text[]) loop
    delete from public.exec_slack_digests d where d.principal_id = p_principal and d.channel_id = v_c;
    get diagnostics v_d = row_count;
    delete from public.exec_slack_channel_links l
     where l.principal_id = p_principal and l.channel_id = v_c
       and not exists (select 1 from public.exec_slack_channels c
                        where c.principal_id = p_principal and c.channel_id = v_c
                          and c.class not in ('deny', 'hub'));
    get diagnostics v_l = row_count;
    channel_id := v_c; digests := v_d; links := v_l;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. RPC 9: exec_chat_finish_turn_v2 (N15; the versioned twin of P5b's RPC 2). P5b's exec_chat_finish_turn keeps its
--    exact 16-argument signature; v2 calls it INSIDE the same transaction and then writes the three Slack columns, so
--    v1's body is never copied (no drift) and the answer and its Slack consults commit together.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_chat_finish_turn_v2(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], text[], boolean, jsonb, text, integer, text[], text[], boolean);
create or replace function public.exec_chat_finish_turn_v2(
  p_principal text, p_message_id text, p_status text, p_status_reason text, p_refusal_category text,
  p_text text, p_recommendations text, p_sources jsonb, p_cards jsonb, p_tool_calls jsonb,
  p_consulted text[], p_consulted_clients text[], p_consulted_dd_text boolean, p_usage jsonb, p_model text, p_ref_seq integer,
  p_slack_refs text[], p_slack_channels text[], p_private_slack boolean
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_ok boolean;
begin
  if coalesce(cardinality(p_slack_refs), 0) > 600 or coalesce(cardinality(p_slack_channels), 0) > 200 then
    raise exception 'exec_chat_finish_turn_v2: too many Slack refs';
  end if;
  v_ok := public.exec_chat_finish_turn(p_principal, p_message_id, p_status, p_status_reason, p_refusal_category, p_text,
            p_recommendations, p_sources, p_cards, p_tool_calls, p_consulted, p_consulted_clients, p_consulted_dd_text,
            p_usage, p_model, p_ref_seq);
  if v_ok and (coalesce(cardinality(p_slack_channels), 0) > 0 or coalesce(p_private_slack, false)) then
    update public.exec_messages m
       set consulted_slack_refs = coalesce(p_slack_refs, '{}'::text[]),
           consulted_slack_channels = coalesce(p_slack_channels, '{}'::text[]),
           consulted_private_slack = coalesce(p_private_slack, false)
     where m.id = p_message_id and m.principal_id = p_principal and m.role = 'assistant';
  end if;
  return v_ok;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. RPC 10: exec_chat_redact_slack (N13, N15, C27). Hits = every assistant message that consulted a listed message
--     key, digest key or channel, or (with p_all) any Slack, plus (backstop, B7's predicate) every message whose cited
--     sources hold a Slack ref in a listed channel or with a listed message key, AND every later assistant message of
--     the same conversation. Each hit is redacted by P5b's own exec_chat_redact_message (text, recommendations,
--     sources, tool-call args, its proposals), so P5b's redaction rules apply unchanged and redacted_at drives P6's
--     Slack follow-up.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_chat_redact_slack(text, text[], text[], text[], boolean, text);
create or replace function public.exec_chat_redact_slack(
  p_principal text, p_message_keys text[], p_digest_keys text[], p_channel_ids text[], p_all boolean, p_text text
) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_id text;
  n    integer := 0;
  v_mk text[] := coalesce(p_message_keys, '{}'::text[]);
  v_dk text[] := coalesce(p_digest_keys, '{}'::text[]);
  v_ch text[] := coalesce(p_channel_ids, '{}'::text[]);
  v_all boolean := coalesce(p_all, false);
begin
  if p_principal is null then return 0; end if;
  if p_text is null or char_length(p_text) not between 1 and 400 then raise exception 'exec_chat_redact_slack: bad text'; end if;
  if cardinality(v_mk) + cardinality(v_dk) + cardinality(v_ch) > 500 then
    raise exception 'exec_chat_redact_slack: at most 500 keys and channels per call';
  end if;
  if not v_all and cardinality(v_mk) + cardinality(v_dk) + cardinality(v_ch) = 0 then return 0; end if;
  for v_id in
    with direct as (
      select m.conversation_id, m.created_at from public.exec_messages m
       where m.principal_id = p_principal and m.role = 'assistant'
         and (m.consulted_slack_refs && v_mk or m.consulted_slack_refs && v_dk or m.consulted_slack_channels && v_ch
              or (v_all and cardinality(m.consulted_slack_channels) > 0))
      union all
      select m.conversation_id, m.created_at from public.exec_messages m
       where m.principal_id = p_principal and m.role = 'assistant'
         and exists (select 1 from jsonb_array_elements(m.sources) as s(e)
                      where s.e #>> '{source,system}' = 'slack'
                        and (v_all
                             or split_part(s.e #>> '{source,id}', ':', 1) = any (v_ch)
                             or ('m:' || (s.e #>> '{source,id}')) = any (v_mk)))
    ), first_hit as (
      select d.conversation_id, min(d.created_at) as at from direct d group by d.conversation_id
    )
    select m.id from public.exec_messages m join first_hit f on f.conversation_id = m.conversation_id
     where m.principal_id = p_principal and m.role = 'assistant' and m.status <> 'running' and m.created_at >= f.at
       and (m.redacted_at is null or m.recommendations <> '' or m.sources <> '[]'::jsonb
            or exists (select 1 from jsonb_array_elements(m.tool_calls) as a(e) where a.e ? 'args'))
     order by m.created_at, m.id
     limit 2000
  loop
    if public.exec_chat_redact_message(p_principal, v_id, p_text) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11, 12. The post-finish recheck and the orphan scan
-- ---------------------------------------------------------------------------

-- RPC 11. After a finish: if anything this answer consulted is already gone, redact it (and later answers). Gone = a
-- message key with a deleted marker or a `message` purge-outbox row (an absence delete, a hub purge, an author purge);
-- a digest key whose (channel, day) row no longer exists or whose rebuilds moved (a blank or a deleted_source finish
-- bumps it; status is ignored, so a "today" rebuild in flight, which keeps rebuilds, is not a removal); a channel whose
-- row is gone, left, or now deny/hub/unclassified; a revoked reading half. Returns true when it redacted.
-- Fixer additions, for what lands while the answer is written (RPC 10 skips a running row, and the sweep's one-shot
-- arms may already have run): a channel with a `conversation` outbox row (reason <> rekey) created since the turn began
-- (an author purge deletes his IMs whole and keeps their rows; correctness-7); an opt-out created since the turn began
-- (every Slack answer, as C33; correctness-7); a digest key whose row was reclaimed since the turn began (a same-generation
-- rebuild replaced the version consulted) while a deleted marker or `message` outbox row falls in its window (the
-- version consulted may have held it, and nothing will blank that generation; security-4).
drop function if exists public.exec_chat_slack_recheck(text, text, text);
create or replace function public.exec_chat_slack_recheck(p_principal text, p_message_id text, p_text text)
returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v     record;
  v_mk  text[];
  v_dk  text[];
  v_ch  text[];
  v_all boolean;
begin
  select m.consulted_slack_refs as refs, m.consulted_slack_channels as chans, m.created_at as at into v
    from public.exec_messages m
   where m.id = p_message_id and m.principal_id = p_principal and m.role = 'assistant';
  if not found or cardinality(v.chans) = 0 then return false; end if;
  v_all := not exists (select 1 from public.exec_slack_installations i
                        where i.principal_id = p_principal and i.revoked_at is null
                          and i.user_revoked_at is null and i.user_token_enc is not null)
           or exists (select 1 from public.exec_slack_author_optouts o
                       where o.principal_id = p_principal and o.created_at >= v.at);
  select coalesce(array_agg(k), '{}'::text[]) into v_mk
    from unnest(v.refs) as k
   where k like 'm:%'
     and (exists (select 1 from public.exec_slack_deleted x
                   where x.principal_id = p_principal and ('m:' || x.channel_id || ':' || x.ts) = k)
          or exists (select 1 from public.exec_slack_purge_log pl
                      where pl.principal_id = p_principal and pl.scope = 'message'
                        and ('m:' || pl.channel_id || ':' || pl.ts) = k));
  -- Unique (principal, channel, day): "no row with this exact generation" = the row is gone or its rebuilds moved.
  select coalesce(array_agg(k), '{}'::text[]) into v_dk
    from unnest(v.refs) as k
   where k like 'd:%'
     and (not exists (select 1 from public.exec_slack_digests d
                       where d.principal_id = p_principal
                         and ('d:' || d.channel_id || ':' || d.local_date::text || ':' || d.rebuilds::text) = k)
          or exists (select 1 from public.exec_slack_digests d
                      where d.principal_id = p_principal
                        and ('d:' || d.channel_id || ':' || d.local_date::text || ':' || d.rebuilds::text) = k
                        and d.requested_at >= v.at
                        and (exists (select 1 from public.exec_slack_deleted x
                                      where x.principal_id = p_principal and x.channel_id = d.channel_id
                                        and x.ts::numeric between d.from_ts::numeric and d.to_ts::numeric)
                             or exists (select 1 from public.exec_slack_purge_log pl
                                         where pl.principal_id = p_principal and pl.scope = 'message' and pl.channel_id = d.channel_id
                                           and pl.ts::numeric between d.from_ts::numeric and d.to_ts::numeric))));
  select coalesce(array_agg(c), '{}'::text[]) into v_ch
    from unnest(v.chans) as c
   where not exists (select 1 from public.exec_slack_channels ch
                      where ch.principal_id = p_principal and ch.channel_id = c
                        and ch.class in ('standard', 'external', 'finance') and ch.left_at is null)
      or exists (select 1 from public.exec_slack_purge_log pl
                  where pl.principal_id = p_principal and pl.scope = 'conversation' and pl.channel_id = c
                    and pl.reason <> 'rekey' and pl.created_at >= v.at);
  if not v_all and cardinality(v_mk) + cardinality(v_dk) + cardinality(v_ch) = 0 then return false; end if;
  return public.exec_chat_redact_slack(p_principal, v_mk, v_dk, v_ch, v_all, p_text) > 0;
end;
$$;

-- RPC 12. Channels that unredacted answers consulted and that are lost: the row is missing, left (left_at set) or
-- now deny/hub/unclassified (the sweep's scan arm; it catches what the 7-day purge outbox no longer holds).
drop function if exists public.exec_chat_slack_orphan_channels(text, integer);
create or replace function public.exec_chat_slack_orphan_channels(p_principal text, p_limit integer)
returns setof text
language sql stable security invoker set search_path = '' as $$
  select distinct c from public.exec_messages m, unnest(m.consulted_slack_channels) as c
   where m.principal_id = p_principal and m.role = 'assistant' and m.redacted_at is null
     and cardinality(m.consulted_slack_channels) > 0
     and not exists (select 1 from public.exec_slack_channels ch
                      where ch.principal_id = p_principal and ch.channel_id = c
                        and ch.class in ('standard', 'external', 'finance') and ch.left_at is null)
   limit least(greatest(coalesce(p_limit, 200), 1), 200)
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on with no policies; nothing for anon/authenticated; service_role only.
-- (exec_messages, exec_drafts and exec_slack_items keep their phases' grants: the new columns and the index inherit them.)
-- P7b grants nothing on P7a's tables and functions; it reads them only from its own SECURITY INVOKER functions,
-- which run as service_role.
-- ---------------------------------------------------------------------------

alter table public.exec_slack_channel_links enable row level security;
alter table public.exec_slack_message_links enable row level security;
alter table public.exec_slack_digests       enable row level security;
revoke all on public.exec_slack_channel_links, public.exec_slack_message_links, public.exec_slack_digests
  from public, anon, authenticated;
grant all on public.exec_slack_channel_links, public.exec_slack_message_links, public.exec_slack_digests to service_role;

revoke all on function public.exec_slack_set_channel_links(text, text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_set_channel_rules(text, jsonb) from public, anon, authenticated;
revoke all on function public.exec_slack_unlinked_messages(text, integer) from public, anon, authenticated;
revoke all on function public.exec_slack_project_items(text, text, text[], timestamptz, integer) from public, anon, authenticated;
revoke all on function public.exec_slack_search(text, text, text[], text[], text[], timestamptz, boolean, integer) from public, anon, authenticated;
revoke all on function public.exec_slack_digest_claim(text, text, date, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.exec_slack_digest_finish(text, text, text, text, jsonb, jsonb, jsonb, text[], jsonb, text, boolean, boolean, text, numeric, boolean)
  from public, anon, authenticated;
revoke all on function public.exec_slack_digest_blank(text, text, text[], date[], boolean) from public, anon, authenticated;
revoke all on function public.exec_chat_finish_turn_v2(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], text[], boolean, jsonb, text,
  integer, text[], text[], boolean) from public, anon, authenticated;
revoke all on function public.exec_chat_redact_slack(text, text[], text[], text[], boolean, text) from public, anon, authenticated;
revoke all on function public.exec_chat_slack_recheck(text, text, text) from public, anon, authenticated;
revoke all on function public.exec_chat_slack_orphan_channels(text, integer) from public, anon, authenticated;
revoke all on function public.exec_slack_public_facts(text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.exec_slack_intel_forget_channels(text, text[], boolean) from public, anon, authenticated;

grant execute on function public.exec_slack_set_channel_links(text, text, text, text, text[]) to service_role;
grant execute on function public.exec_slack_set_channel_rules(text, jsonb) to service_role;
grant execute on function public.exec_slack_unlinked_messages(text, integer) to service_role;
grant execute on function public.exec_slack_project_items(text, text, text[], timestamptz, integer) to service_role;
grant execute on function public.exec_slack_search(text, text, text[], text[], text[], timestamptz, boolean, integer) to service_role;
grant execute on function public.exec_slack_digest_claim(text, text, date, text, text, text, timestamptz, text) to service_role;
grant execute on function public.exec_slack_digest_finish(text, text, text, text, jsonb, jsonb, jsonb, text[], jsonb, text, boolean, boolean, text, numeric, boolean)
  to service_role;
grant execute on function public.exec_slack_digest_blank(text, text, text[], date[], boolean) to service_role;
grant execute on function public.exec_chat_finish_turn_v2(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], text[], boolean, jsonb, text,
  integer, text[], text[], boolean) to service_role;
grant execute on function public.exec_chat_redact_slack(text, text[], text[], text[], boolean, text) to service_role;
grant execute on function public.exec_chat_slack_recheck(text, text, text) to service_role;
grant execute on function public.exec_chat_slack_orphan_channels(text, integer) to service_role;
grant execute on function public.exec_slack_public_facts(text, text, timestamptz, integer) to service_role;
grant execute on function public.exec_slack_intel_forget_channels(text, text[], boolean) to service_role;

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
--   * every column of the three new tables with type and nullability, the new
--     columns of exec_messages and exec_drafts, the generated columns (the five
--     verdict columns and search_tsv), no column named excerpt on a P7b table,
--     and the defaults the app relies on;
--   * every named CHECK, validated (several by the words their definition must
--     hold);
--   * the primary keys, the unique day key, and the foreign keys with BOTH
--     their ON UPDATE and ON DELETE actions;
--   * every index by its definition (the text after " USING ") and uniqueness,
--     incl. the search index on P7a's exec_slack_items;
--   * the fourteen functions: SECURITY INVOKER with search_path pinned, one
--     signature each; P5b's exec_chat_finish_turn still present with its
--     16-parameter signature next to v2;
--   * what this file relies on from P5b, P6 and P7a (the pre-flight's tables,
--     key and columns), so a later re-apply of an earlier phase that loses one
--     turns a row false.
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
  select e.label, x.wrong is null, x.wrong
  from (values
    ('columns: exec_slack_channel_links', 'exec_slack_channel_links'), ('columns: exec_slack_message_links', 'exec_slack_message_links'),
    ('columns: exec_slack_digests', 'exec_slack_digests'),
    ('columns (P7b): exec_messages', 'exec_messages'), ('columns (P7b): exec_drafts', 'exec_drafts')
  ) e(label, tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_slack_channel_links', 1, 'principal_id', 'text', true),
      ('exec_slack_channel_links', 2, 'channel_id', 'text', true),
      ('exec_slack_channel_links', 3, 'tag_client_id', 'text', false),
      ('exec_slack_channel_links', 4, 'tag_client_name', 'text', false),
      ('exec_slack_channel_links', 5, 'tag_project_ids', 'text[]', true),
      ('exec_slack_channel_links', 6, 'tagged_at', 'timestamp with time zone', false),
      ('exec_slack_channel_links', 7, 'rule_client_id', 'text', false),
      ('exec_slack_channel_links', 8, 'rule_client_name', 'text', false),
      ('exec_slack_channel_links', 9, 'rule_candidates', 'integer', true),
      ('exec_slack_channel_links', 10, 'rule_computed_at', 'timestamp with time zone', false),
      ('exec_slack_channel_links', 11, 'client_id', 'text', false),
      ('exec_slack_channel_links', 12, 'client_name', 'text', false),
      ('exec_slack_channel_links', 13, 'client_match_via', 'text', false),
      ('exec_slack_channel_links', 14, 'match_confidence', 'text', false),
      ('exec_slack_channel_links', 15, 'client_candidates', 'integer', false),
      ('exec_slack_channel_links', 16, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_channel_links', 17, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_message_links', 1, 'principal_id', 'text', true),
      ('exec_slack_message_links', 2, 'channel_id', 'text', true),
      ('exec_slack_message_links', 3, 'ts', 'text', true),
      ('exec_slack_message_links', 4, 'client_id', 'text', false),
      ('exec_slack_message_links', 5, 'client_name', 'text', false),
      ('exec_slack_message_links', 6, 'client_match_via', 'text', false),
      ('exec_slack_message_links', 7, 'match_confidence', 'text', false),
      ('exec_slack_message_links', 8, 'client_candidates', 'integer', true),
      ('exec_slack_message_links', 9, 'task_ids', 'text[]', true),
      ('exec_slack_message_links', 10, 'project_ids', 'text[]', true),
      ('exec_slack_message_links', 11, 'email_thread_ids', 'text[]', true),
      ('exec_slack_message_links', 12, 'checked_at', 'timestamp with time zone', true),
      ('exec_slack_digests', 1, 'id', 'text', true),
      ('exec_slack_digests', 2, 'principal_id', 'text', true),
      ('exec_slack_digests', 3, 'channel_id', 'text', true),
      ('exec_slack_digests', 4, 'local_date', 'date', true),
      ('exec_slack_digests', 5, 'tz', 'text', true),
      ('exec_slack_digests', 6, 'from_ts', 'text', true),
      ('exec_slack_digests', 7, 'to_ts', 'text', true),
      ('exec_slack_digests', 8, 'status', 'text', true),
      ('exec_slack_digests', 9, 'summary', 'text', false),
      ('exec_slack_digests', 10, 'highlights', 'jsonb', true),
      ('exec_slack_digests', 11, 'decisions', 'jsonb', true),
      ('exec_slack_digests', 12, 'open_questions', 'jsonb', true),
      ('exec_slack_digests', 13, 'source_ts', 'text[]', true),
      ('exec_slack_digests', 14, 'human_count', 'integer', true),
      ('exec_slack_digests', 15, 'bot_count', 'integer', true),
      ('exec_slack_digests', 16, 'dd_post_count', 'integer', true),
      ('exec_slack_digests', 17, 'external_count', 'integer', true),
      ('exec_slack_digests', 18, 'thread_count', 'integer', true),
      ('exec_slack_digests', 19, 'privacy', 'text', false),
      ('exec_slack_digests', 20, 'partial', 'boolean', true),
      ('exec_slack_digests', 21, 'full_day', 'boolean', true),
      ('exec_slack_digests', 22, 'injection_suspected', 'boolean', true),
      ('exec_slack_digests', 23, 'rebuilds', 'integer', true),
      ('exec_slack_digests', 24, 'model', 'text', false),
      ('exec_slack_digests', 25, 'cost_usd', 'numeric(10,4)', false),
      ('exec_slack_digests', 26, 'requested_at', 'timestamp with time zone', true),
      ('exec_slack_digests', 27, 'built_at', 'timestamp with time zone', false),
      ('exec_slack_digests', 28, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_digests', 29, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_digests', 30, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_digests', 31, 'search_tsv', 'tsvector', false),
      ('exec_messages', 1, 'consulted_slack_refs', 'text[]', true),
      ('exec_messages', 2, 'consulted_slack_channels', 'text[]', true),
      ('exec_messages', 3, 'consulted_private_slack', 'boolean', true),
      ('exec_drafts', 1, 'purpose', 'text', true),
      ('exec_drafts', 2, 'generated_version', 'integer', false),
      ('exec_drafts', 3, 'client_update_facts', 'jsonb', false)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  -- C2: the five verdict columns and the digest search vector are GENERATED (stored), from the right base columns.
  select 'generated: ' || e.tbl || '.' || e.col, coalesce(x.gen = 's' and x.missing is null, false),
         case when not coalesce(x.gen = 's' and x.missing is null, false)
              then coalesce('attgenerated ' || nullif(x.gen, '') || coalesce(', expression lacks ' || x.missing, ''), '(not generated)') end
  from (values
    ('exec_slack_channel_links', 'client_id', array['tag_client_id', 'rule_client_id']),
    ('exec_slack_channel_links', 'client_name', array['tag_client_id', 'tag_client_name', 'rule_client_name']),
    ('exec_slack_channel_links', 'client_match_via', array['tag_client_id', 'rule_client_id', 'rule_candidates', 'tag', 'name']),
    ('exec_slack_channel_links', 'match_confidence', array['tag_client_id', 'rule_client_id', 'rule_candidates', 'high', 'low']),
    ('exec_slack_channel_links', 'client_candidates', array['tag_client_id', 'rule_candidates']),
    ('exec_slack_digests', 'search_tsv', array['to_tsvector', 'simple', 'summary'])
  ) e(tbl, col, needs)
  left join lateral (
    select a.attgenerated::text as gen,
           (select string_agg(w, ', ') from unnest(e.needs) w
             where coalesce(pg_get_expr(d.adbin, d.adrelid), '') !~ ('\m' || w || '\M')) as missing
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = e.col and not a.attisdropped
  ) x on true
  union all
  -- N7 / B-P7b-3: excerpts have one writer (P7a's exec_slack_items); no P7b table has an excerpt column.
  select 'no excerpt column: ' || e.tbl, x.found is null, case when x.found is not null then 'found: ' || x.found end
  from (values ('exec_slack_channel_links'), ('exec_slack_message_links'), ('exec_slack_digests')) e(tbl)
  cross join lateral (
    select string_agg(a.attname::text, ', ') as found from pg_attribute a
     where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped and a.attname::text ~ 'excerpt'
  ) x
  union all
  select e.label, x.wrong is null, x.wrong
  from (values
    ('defaults: exec_slack_channel_links', 'exec_slack_channel_links'), ('defaults: exec_slack_message_links', 'exec_slack_message_links'),
    ('defaults: exec_slack_digests', 'exec_slack_digests'),
    ('defaults (P7b): exec_messages', 'exec_messages'), ('defaults (P7b): exec_drafts', 'exec_drafts')
  ) e(label, tbl)
  cross join lateral (
    select string_agg(k.col || ' default ' || k.def, ', ' order by k.col) as wrong
    from (values
      ('exec_slack_channel_links', 'tag_project_ids', '''{}''::text[]'),
      ('exec_slack_channel_links', 'rule_candidates', '0'),
      ('exec_slack_channel_links', 'created_at', 'now()'),
      ('exec_slack_channel_links', 'updated_at', 'now()'),
      ('exec_slack_message_links', 'client_candidates', '0'),
      ('exec_slack_message_links', 'task_ids', '''{}''::text[]'),
      ('exec_slack_message_links', 'project_ids', '''{}''::text[]'),
      ('exec_slack_message_links', 'email_thread_ids', '''{}''::text[]'),
      ('exec_slack_message_links', 'checked_at', 'now()'),
      ('exec_slack_digests', 'id', '(''esd_''::text || replace((gen_random_uuid())::text, ''-''::text, ''''::text))'),
      ('exec_slack_digests', 'highlights', '''[]''::jsonb'),
      ('exec_slack_digests', 'decisions', '''[]''::jsonb'),
      ('exec_slack_digests', 'open_questions', '''[]''::jsonb'),
      ('exec_slack_digests', 'source_ts', '''{}''::text[]'),
      ('exec_slack_digests', 'human_count', '0'),
      ('exec_slack_digests', 'bot_count', '0'),
      ('exec_slack_digests', 'dd_post_count', '0'),
      ('exec_slack_digests', 'external_count', '0'),
      ('exec_slack_digests', 'thread_count', '0'),
      ('exec_slack_digests', 'partial', 'false'),
      ('exec_slack_digests', 'full_day', 'false'),
      ('exec_slack_digests', 'injection_suspected', 'false'),
      ('exec_slack_digests', 'rebuilds', '0'),
      ('exec_slack_digests', 'requested_at', 'now()'),
      ('exec_slack_digests', 'created_at', 'now()'),
      ('exec_slack_digests', 'updated_at', 'now()'),
      ('exec_messages', 'consulted_slack_refs', '''{}''::text[]'),
      ('exec_messages', 'consulted_slack_channels', '''{}''::text[]'),
      ('exec_messages', 'consulted_private_slack', 'false'),
      ('exec_drafts', 'purpose', '''reply''::text')
    ) k(tbl, col, def)
    where k.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = k.col and not a.attisdropped
          and a.attgenerated = '' and pg_get_expr(d.adbin, d.adrelid) = k.def)
  ) x
  union all
  select e.label, x.missing is null, x.missing
  from (values
    ('checks: exec_slack_channel_links', 'exec_slack_channel_links'), ('checks: exec_slack_message_links', 'exec_slack_message_links'),
    ('checks: exec_slack_digests', 'exec_slack_digests'),
    ('checks (P7b): exec_messages', 'exec_messages'), ('checks (P7b): exec_drafts', 'exec_drafts')
  ) e(label, tbl)
  cross join lateral (
    select string_agg(k.name || case when d.def is null then '' when not d.valid then ' (not validated)' else ' (definition)' end,
                      ', ' order by k.name) as missing
    from (values
      ('exec_slack_channel_links', 'exec_slack_channel_links_channel_check', array['channel_id']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_tag_client_check', array['tag_client_id', '100']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_tag_name_check', array['tag_client_name', '200']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_tag_projects_check', array['tag_project_ids', '10']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_rule_client_check', array['rule_client_id', '100']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_rule_name_check', array['rule_client_name', '200']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_rule_candidates_check', array['rule_candidates', '1000']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_tag_pair_check', array['tag_client_id', 'tag_client_name']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_tagged_at_check', array['tagged_at', 'tag_client_id', 'tag_project_ids']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_rule_pair_check', array['rule_client_id', 'rule_client_name']),
      ('exec_slack_channel_links', 'exec_slack_channel_links_rule_shape_check', array['rule_client_id', 'rule_candidates', '1']),
      ('exec_slack_message_links', 'exec_slack_message_links_ts_check', array['ts']),
      ('exec_slack_message_links', 'exec_slack_message_links_client_check', array['client_id', '100']),
      ('exec_slack_message_links', 'exec_slack_message_links_client_name_check', array['client_name', '200']),
      ('exec_slack_message_links', 'exec_slack_message_links_via_check', array['dd_post', 'dd_link', 'domain']),
      ('exec_slack_message_links', 'exec_slack_message_links_confidence_check', array['high', 'medium', 'low']),
      ('exec_slack_message_links', 'exec_slack_message_links_candidates_check', array['client_candidates', '1000']),
      ('exec_slack_message_links', 'exec_slack_message_links_tasks_check', array['task_ids', '20']),
      ('exec_slack_message_links', 'exec_slack_message_links_projects_check', array['project_ids', '20']),
      ('exec_slack_message_links', 'exec_slack_message_links_threads_check', array['email_thread_ids', '5']),
      ('exec_slack_message_links', 'exec_slack_message_links_pair_check', array['client_id', 'client_name']),
      ('exec_slack_message_links', 'exec_slack_message_links_verdict_check',
       array['client_match_via', 'match_confidence', 'dd_post', 'dd_link', 'domain', 'high', 'medium', 'low', 'client_candidates']),
      ('exec_slack_digests', 'exec_slack_digests_tz_check', array['tz', '64']),
      ('exec_slack_digests', 'exec_slack_digests_from_check', array['from_ts']),
      ('exec_slack_digests', 'exec_slack_digests_to_check', array['to_ts']),
      ('exec_slack_digests', 'exec_slack_digests_status_check', array['building', 'built', 'empty', 'stale', 'failed', 'skipped_cap']),
      ('exec_slack_digests', 'exec_slack_digests_summary_check', array['summary', '1200']),
      ('exec_slack_digests', 'exec_slack_digests_highlights_check', array['highlights', '6']),
      ('exec_slack_digests', 'exec_slack_digests_decisions_check', array['decisions', '6']),
      ('exec_slack_digests', 'exec_slack_digests_questions_check', array['open_questions', '6']),
      ('exec_slack_digests', 'exec_slack_digests_source_check', array['source_ts', '2000']),
      ('exec_slack_digests', 'exec_slack_digests_human_check', array['human_count']),
      ('exec_slack_digests', 'exec_slack_digests_bot_check', array['bot_count']),
      ('exec_slack_digests', 'exec_slack_digests_dd_check', array['dd_post_count']),
      ('exec_slack_digests', 'exec_slack_digests_external_check', array['external_count']),
      ('exec_slack_digests', 'exec_slack_digests_thread_check', array['thread_count']),
      ('exec_slack_digests', 'exec_slack_digests_privacy_check', array['public', 'private', 'group_dm', 'external', 'finance']),
      ('exec_slack_digests', 'exec_slack_digests_rebuilds_check', array['rebuilds', '1000']),
      ('exec_slack_digests', 'exec_slack_digests_model_check', array['model', '64']),
      ('exec_slack_digests', 'exec_slack_digests_cost_check', array['cost_usd']),
      ('exec_slack_digests', 'exec_slack_digests_content_check',
       array['built', 'summary', 'source_ts', 'built_at', 'highlights', 'decisions', 'open_questions']),
      ('exec_slack_digests', 'exec_slack_digests_sources_check', array['built', 'empty', 'source_ts']),
      ('exec_slack_digests', 'exec_slack_digests_full_day_check', array['full_day', 'built', 'empty']),
      ('exec_slack_digests', 'exec_slack_digests_range_check', array['from_ts', 'to_ts']),
      ('exec_messages', 'exec_messages_slack_refs_check', array['consulted_slack_refs', '600']),
      ('exec_messages', 'exec_messages_slack_channels_check', array['consulted_slack_channels', '200']),
      ('exec_messages', 'exec_messages_user_row_slack_check',
       array['assistant', 'consulted_slack_refs', 'consulted_slack_channels', 'consulted_private_slack']),
      ('exec_messages', 'exec_messages_slack_pair_check', array['consulted_slack_refs', 'consulted_slack_channels']),
      ('exec_drafts', 'exec_drafts_purpose_check', array['purpose', 'reply', 'client_update']),
      ('exec_drafts', 'exec_drafts_purpose_kind_check', array['purpose', 'kind', 'reply']),
      ('exec_drafts', 'exec_drafts_generated_version_check', array['generated_version', 'version']),
      ('exec_drafts', 'exec_drafts_client_update_facts_check', array['client_update_facts', 'purpose', 'client_update', '2048'])
    ) k(tbl, name, needs)
    cross join lateral (
      select pg_get_constraintdef(pc.oid) as def, pc.convalidated as valid
      from pg_constraint pc
      where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = k.name
      union all
      select null::text, null::boolean where not exists (select 1 from pg_constraint pc
                                                          where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c'
                                                            and pc.conname = k.name)
    ) d
    where k.tbl = e.tbl
      and (d.def is null or not d.valid
           or (k.needs is not null and exists (
                 select 1 from unnest(k.needs) w
                  where case when w ~ '^[A-Za-z0-9_:.]+$' then d.def !~ ('\m' || w || '\M') else strpos(d.def, w) = 0 end)))
  ) x
  union all
  select e.label, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('primary key: exec_slack_channel_links', 'exec_slack_channel_links', 'exec_slack_channel_links_pkey', 'p', array['principal_id', 'channel_id']),
    ('primary key: exec_slack_message_links', 'exec_slack_message_links', 'exec_slack_message_links_pkey', 'p',
     array['principal_id', 'channel_id', 'ts']),
    ('primary key: exec_slack_digests', 'exec_slack_digests', 'exec_slack_digests_pkey', 'p', array['id']),
    ('unique: exec_slack_digests_day_key (principal_id, channel_id, local_date)', 'exec_slack_digests', 'exec_slack_digests_day_key', 'u',
     array['principal_id', 'channel_id', 'local_date'])
  ) e(label, tbl, name, kind, cols)
  left join lateral (
    select k.contype::text = e.kind and c.cols = e.cols as ok,
           k.contype::text || ' (' || array_to_string(c.cols, ', ') || ')' as found
    from pg_constraint k
    cross join lateral (
      select array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                   order by u.ord) as cols) c
    where k.conrelid = to_regclass('public.' || e.tbl) and k.conname = e.name
  ) x on true
  union all
  select 'FK on update ' || e.upd || ' on delete ' || e.del || ': ' || e.tbl || ' (' || array_to_string(e.cols, ', ') || ') -> ' || e.ref,
         coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_slack_channel_links', 'exec_slack_channel_links_channel_fkey', array['principal_id', 'channel_id'], 'exec_slack_channels',
     array['principal_id', 'channel_id'], 'cascade', 'cascade'),
    ('exec_slack_message_links', 'exec_slack_message_links_message_fkey', array['principal_id', 'channel_id', 'ts'], 'exec_slack_messages',
     array['principal_id', 'channel_id', 'ts'], 'cascade', 'cascade'),
    ('exec_slack_digests', 'exec_slack_digests_channel_fkey', array['principal_id', 'channel_id'], 'exec_slack_channels',
     array['principal_id', 'channel_id'], 'cascade', 'cascade')
  ) e(tbl, name, cols, ref, refcols, upd, del)
  left join lateral (
    select k.confrelid = to_regclass('public.' || e.ref) and k.confupdtype = 'c' and k.confdeltype = 'c'
             and c.cols = e.cols and c.refcols = e.refcols as ok,
           'references ' || k.confrelid::regclass::text || ' (' || array_to_string(c.refcols, ', ') || ') from ('
             || array_to_string(c.cols, ', ') || ') on update ' || k.confupdtype::text || ' on delete ' || k.confdeltype::text as found
    from pg_constraint k
    cross join lateral (
      select array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord) as cols,
             array(select a.attname::text from unnest(k.confkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum order by u.ord) as refcols) c
    where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'f' and k.conname = e.name
  ) x on true
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def and x.uniq = e.uniq, false),
         case when not coalesce(x.def = e.def and x.uniq = e.uniq, false)
              then coalesce(case when x.uniq then 'unique ' else '' end || x.def, '(missing)') end
  from (values
    ('exec_slack_channel_links', 'exec_slack_channel_links_client_idx', 'btree (principal_id, client_id) WHERE (client_id IS NOT NULL)', false),
    ('exec_slack_channel_links', 'exec_slack_channel_links_projects_idx', 'gin (tag_project_ids)', false),
    ('exec_slack_message_links', 'exec_slack_message_links_tasks_idx', 'gin (task_ids)', false),
    ('exec_slack_message_links', 'exec_slack_message_links_projects_idx', 'gin (project_ids)', false),
    ('exec_slack_message_links', 'exec_slack_message_links_client_idx', 'btree (principal_id, client_id) WHERE (client_id IS NOT NULL)', false),
    ('exec_slack_digests', 'exec_slack_digests_day_key', 'btree (principal_id, channel_id, local_date)', true),
    ('exec_slack_digests', 'exec_slack_digests_date_idx', 'btree (principal_id, local_date DESC)', false),
    ('exec_slack_digests', 'exec_slack_digests_building_idx', 'btree (requested_at) WHERE (status = ''building''::text)', false),
    ('exec_slack_digests', 'exec_slack_digests_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_digests', 'exec_slack_digests_search_idx', 'gin (search_tsv)', false),
    ('exec_slack_items', 'exec_slack_items_search_idx',
     'gin (to_tsvector(''simple''::regconfig, ((COALESCE(summary, ''''::text) || '' ''::text) || COALESCE(excerpt, ''''::text))))', false),
    ('exec_messages', 'exec_messages_slack_refs_idx', 'gin (consulted_slack_refs)', false),
    ('exec_messages', 'exec_messages_slack_channels_idx', 'gin (consulted_slack_channels)', false),
    ('exec_messages', 'exec_messages_slack_any_idx', 'btree (principal_id) WHERE (cardinality(consulted_slack_channels) > 0)', false)
  ) e(tbl, name, def, uniq)
  left join lateral (
    select substr(pg_get_indexdef(i.indexrelid), strpos(pg_get_indexdef(i.indexrelid), ' USING ') + 7) as def,
           i.indisunique as uniq
    from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = to_regclass('public.' || e.tbl) and ic.relname = e.name
  ) x on true
  union all
  select 'security invoker, search_path pinned: ' || e.fn, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_slack_set_channel_links(text,text,text,text,text[])'),
    ('exec_slack_set_channel_rules(text,jsonb)'),
    ('exec_slack_unlinked_messages(text,integer)'),
    ('exec_slack_project_items(text,text,text[],timestamptz,integer)'),
    ('exec_slack_search(text,text,text[],text[],text[],timestamptz,boolean,integer)'),
    ('exec_slack_digest_claim(text,text,date,text,text,text,timestamptz,text)'),
    ('exec_slack_digest_finish(text,text,text,text,jsonb,jsonb,jsonb,text[],jsonb,text,boolean,boolean,text,numeric,boolean)'),
    ('exec_slack_digest_blank(text,text,text[],date[],boolean)'),
    ('exec_chat_finish_turn_v2(text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text[],text[],boolean,jsonb,text,integer,text[],text[],boolean)'),
    ('exec_chat_redact_slack(text,text[],text[],text[],boolean,text)'),
    ('exec_chat_slack_recheck(text,text,text)'),
    ('exec_chat_slack_orphan_channels(text,integer)'),
    ('exec_slack_public_facts(text,text,timestamptz,integer)'),
    ('exec_slack_intel_forget_channels(text,text[],boolean)')
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
  from (values ('exec_slack_set_channel_links'), ('exec_slack_set_channel_rules'), ('exec_slack_unlinked_messages'),
               ('exec_slack_project_items'), ('exec_slack_search'), ('exec_slack_digest_claim'), ('exec_slack_digest_finish'),
               ('exec_slack_digest_blank'), ('exec_chat_finish_turn_v2'), ('exec_chat_redact_slack'), ('exec_chat_slack_recheck'),
               ('exec_chat_slack_orphan_channels'), ('exec_slack_public_facts'), ('exec_slack_intel_forget_channels')) e(name)
  cross join lateral (
    select count(*)::int as n, string_agg(p.oid::regprocedure::text, '; ') as sigs
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = e.name
  ) x
  union all
  -- v2 calls v1 inside its own transaction (no copy of v1's body), so v1 must stay exactly as P5b defined it.
  select 'still present (P5b): exec_chat_finish_turn with its 16-parameter signature',
         to_regprocedure('public.exec_chat_finish_turn(text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text[],text[],boolean,jsonb,text,integer)')
           is not null,
         case when to_regprocedure('public.exec_chat_finish_turn(text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text[],text[],boolean,jsonb,text,integer)')
                   is null then '(missing)' end
  union all
  select 'relies on (P5b): function ' || e.fn, to_regprocedure('public.' || e.fn) is not null,
         case when to_regprocedure('public.' || e.fn) is null then '(missing)' end
  from (values ('exec_chat_redact_message(text,text,text)')) e(fn)
  union all
  select 'relies on (' || e.phase || '): check ' || e.name,
         exists (select 1 from pg_constraint k where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'c' and k.conname = e.name),
         case when not exists (select 1 from pg_constraint k
                                where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'c' and k.conname = e.name) then '(missing)' end
  from (values ('P5b', 'exec_messages', 'exec_messages_user_row_check')) e(phase, tbl, name)
  union all
  select 'relies on (P6): unique index exec_slack_installations_active_key', coalesce(x.uniq, false),
         case when not coalesce(x.uniq, false) then coalesce(case when x.uniq then 'unique' else 'not unique' end, '(missing)') end
  from (select 1) one
  left join lateral (
    select i.indisunique as uniq from pg_index i join pg_class ic on ic.oid = i.indexrelid
     where i.indrelid = to_regclass('public.exec_slack_installations') and ic.relname = 'exec_slack_installations_active_key'
  ) x on true
  union all
  select 'relies on (P7a): table ' || e.tbl, to_regclass('public.' || e.tbl) is not null,
         case when to_regclass('public.' || e.tbl) is null then '(missing)' end
  from (values ('exec_slack_channels'), ('exec_slack_messages'), ('exec_slack_items'), ('exec_slack_deleted'), ('exec_slack_purge_log'),
               ('exec_slack_author_optouts')) e(tbl)
  union all
  select 'relies on (P7a): key (principal_id, channel_id) on exec_slack_channels',
         exists (select 1 from pg_constraint k
                  where k.conrelid = to_regclass('public.exec_slack_channels') and k.contype in ('p', 'u')
                    and pg_get_constraintdef(k.oid) ~ '\(principal_id, channel_id\)'),
         case when not exists (select 1 from pg_constraint k
                                where k.conrelid = to_regclass('public.exec_slack_channels') and k.contype in ('p', 'u')
                                  and pg_get_constraintdef(k.oid) ~ '\(principal_id, channel_id\)') then '(missing)' end
  union all
  select 'relies on (' || e.phase || '): column ' || e.tbl || '.' || e.col, x.typ is not null,
         case when x.typ is null then '(missing)' end
  from (values
    ('P7a', 'exec_slack_channels', 'conv_type'), ('P7a', 'exec_slack_channels', 'is_private'), ('P7a', 'exec_slack_channels', 'class'),
    ('P7a', 'exec_slack_channels', 'watch_state'), ('P7a', 'exec_slack_channels', 'left_at'), ('P7a', 'exec_slack_channels', 'is_ext_shared'),
    ('P7a', 'exec_slack_channels', 'ext_ever'), ('P7a', 'exec_slack_channels', 'finance_name'),
    ('P7a', 'exec_slack_messages', 'dd_paths'), ('P7a', 'exec_slack_messages', 'is_dd_post'), ('P7a', 'exec_slack_messages', 'author_external'),
    ('P7a', 'exec_slack_items', 'source_class'), ('P7a', 'exec_slack_items', 'bypass_mute'), ('P7a', 'exec_slack_items', 'author_user_id'),
    ('P7a', 'exec_slack_author_optouts', 'author_user_id'), ('P7a', 'exec_slack_author_optouts', 'created_at'),
    ('P7a', 'exec_slack_installations', 'user_revoked_at'), ('P7a', 'exec_slack_installations', 'user_token_enc')
  ) e(phase, tbl, col)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) as typ from pg_attribute a
     where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = e.col and a.attnum > 0 and not a.attisdropped
  ) x on true
) checks
order by ok, check_name;
