-- Executive AI Assistant - P5b chat.
--
--   exec_conversations   one chat thread of the principal (web now, Slack DMs in P6).
--   exec_messages        its turns, as TEXT only: his question, and the assistant's
--                        answer, suggestions, cited sources and tool calls (names +
--                        arguments, never results), plus which threads, clients and
--                        DD text it consulted (ids and a flag). The chat carve-out from
--                        the no-content rule: answers may quote DD text and his email;
--                        a restricted-sender tombstone redacts them, and every later
--                        answer of the same conversation (exec_chat_redact_threads).
--   exec_task_proposals  tasks the assistant staged; nothing exists in DD until he
--                        confirms one (POST /api/exec/tasks/proposals/:id/confirm).
--   exec_settings        + chat_enabled, ask_ai_uses_exec, chat_daily_cap_usd.
--   exec_drafts (P4)     + exec_drafts_purge_by_ids (chat drafts of redacted answers),
--                        the 'private_refs' review blocker (the second confirmation) and
--                        instruction_by (who wrote the current instruction: owner | assistant).
--
-- Security: RLS ON, NO policies, nothing for anon/authenticated; functions are
-- SECURITY INVOKER with a pinned search_path and EXECUTE for service_role only.
-- Idempotent. Apply MANUALLY in the Supabase SQL editor, after the P4 and P5a migrations.
-- Chat stays off until it is switched on from the Settings page (chat_enabled); the
-- Ask AI routing (ask_ai_uses_exec) is a second switch on the same page.

set local lock_timeout = '5s';

-- Pre-flight: P2a, and P4's drafts table (the chat-draft pieces at the end). Aborts before changing anything.
do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_settings') is null then
    raise exception 'exec chat aborted, nothing changed: the P2a foundation is missing (apply 20261104100000_exec_foundation.sql first)';
  end if;
  if to_regclass('public.exec_drafts') is null then
    raise exception 'exec chat aborted, nothing changed: the P4 drafts table is missing (apply 20261105200000_exec_drafts.sql first)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

alter table public.exec_settings add column if not exists chat_enabled boolean not null default false;
alter table public.exec_settings add column if not exists ask_ai_uses_exec boolean not null default false;
alter table public.exec_settings add column if not exists chat_daily_cap_usd numeric(10, 2) not null default 9;
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_settings'::regclass and conname = 'exec_settings_chat_daily_cap_check') then
    alter table public.exec_settings add constraint exec_settings_chat_daily_cap_check
      check (chat_daily_cap_usd >= 0 and chat_daily_cap_usd <= 1000);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table if not exists public.exec_conversations (
  id                    text primary key default ('ecv_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id          text not null references public.exec_principals(id) on delete cascade,
  surface               text not null
                          constraint exec_conversations_surface_check check (surface in ('web', 'slack')),
  title                 text not null
                          constraint exec_conversations_title_check check (char_length(title) between 1 and 120),
  -- The client turn id of the request that created it: a retried first POST
  -- (no conversationId yet) finds the conversation instead of making a second.
  create_client_turn_id text not null
                          constraint exec_conversations_create_turn_check check (char_length(create_client_turn_id) between 8 and 100),
  slack_channel_id      text constraint exec_conversations_slack_channel_check
                          check (slack_channel_id is null or char_length(slack_channel_id) between 1 and 40),
  slack_thread_ts       text constraint exec_conversations_slack_ts_check
                          check (slack_thread_ts is null or char_length(slack_thread_ts) between 1 and 40),
  -- Highest ref number issued (r1, r2, ...): refs are never reused in a conversation.
  ref_seq               integer not null default 0
                          constraint exec_conversations_ref_seq_check check (ref_seq between 0 and 100000),
  turn_count            integer not null default 0
                          constraint exec_conversations_turn_count_check check (turn_count >= 0),
  last_message_at       timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  constraint exec_conversations_create_turn_key unique (principal_id, create_client_turn_id),
  constraint exec_conversations_slack_pair_check check ((slack_channel_id is null) = (slack_thread_ts is null)),
  constraint exec_conversations_web_check check (surface = 'slack' or slack_channel_id is null)
);
create unique index if not exists exec_conversations_slack_thread_key
  on public.exec_conversations (principal_id, slack_channel_id, slack_thread_ts) where slack_thread_ts is not null;
create index if not exists exec_conversations_recent_idx on public.exec_conversations (principal_id, last_message_at desc);
create index if not exists exec_conversations_expires_idx on public.exec_conversations (expires_at);

-- ---------------------------------------------------------------------------
-- Messages (two rows per turn: the question, then the answer)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_messages (
  id               text primary key default ('ecm_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id     text not null references public.exec_principals(id) on delete cascade,
  conversation_id  text not null references public.exec_conversations(id) on delete cascade,
  turn_id          text not null constraint exec_messages_turn_id_check check (turn_id ~ '^ect_[0-9a-f]{32}$'),
  role             text not null constraint exec_messages_role_check check (role in ('user', 'assistant')),
  client_turn_id   text not null constraint exec_messages_client_turn_check check (char_length(client_turn_id) between 8 and 100),
  status           text not null
                     constraint exec_messages_status_check
                     check (status in ('running', 'complete', 'aborted', 'refused', 'failed', 'capped')),
  status_reason    text constraint exec_messages_status_reason_check
                     check (status_reason is null or status_reason ~ '^[a-z_]{1,40}$'),
  refusal_category text constraint exec_messages_refusal_category_check
                     check (refusal_category is null or char_length(refusal_category) <= 60),
  text             text not null default '' constraint exec_messages_text_check check (char_length(text) <= 40000),
  recommendations  text not null default ''
                     constraint exec_messages_recommendations_check check (char_length(recommendations) <= 8000),
  -- User rows: { kind, id, ref } of the context he asked from. Never a label.
  context          jsonb constraint exec_messages_context_check check (context is null or jsonb_typeof(context) = 'object'),
  -- [{ ref, target, source }] - the refs this answer cited (SourceRef in source). Emptied by a redaction.
  sources          jsonb not null default '[]'::jsonb
                     constraint exec_messages_sources_check
                     check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 60),
  -- [{ kind: 'task_proposal', id } | { kind: 'draft', id, existing, privateRefKinds }] - code caps a turn at 8 (C40).
  cards            jsonb not null default '[]'::jsonb
                     constraint exec_messages_cards_check check (jsonb_typeof(cards) = 'array' and jsonb_array_length(cards) <= 10),
  -- [{ round, name, args, ok, error, ms }] - names and arguments, never results; code keeps the first 100 (C14).
  tool_calls       jsonb not null default '[]'::jsonb
                     constraint exec_messages_tool_calls_check
                     check (jsonb_typeof(tool_calls) = 'array' and jsonb_array_length(tool_calls) <= 100),
  -- C19: threads the tools read (<= 500, C41), plus the threads of cited sources (<= 60) and intake links.
  consulted_email_thread_ids text[] not null default '{}'
                     constraint exec_messages_consulted_check check (cardinality(consulted_email_thread_ids) <= 600),
  -- C24: clients whose records the tools returned (ids only) and whether S4 DD text was read.
  consulted_client_ids text[] not null default '{}'
                     constraint exec_messages_consulted_clients_check check (cardinality(consulted_client_ids) <= 500),
  consulted_dd_text boolean not null default false,
  usage            jsonb constraint exec_messages_usage_check check (usage is null or jsonb_typeof(usage) = 'object'),
  model            text constraint exec_messages_model_check check (model is null or char_length(model) <= 64),
  slack_ts         text constraint exec_messages_slack_ts_check check (slack_ts is null or char_length(slack_ts) between 1 and 40),
  redacted_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  expires_at       timestamptz not null,
  constraint exec_messages_turn_role_key unique (conversation_id, client_turn_id, role),
  -- A question is a finished, plain row: his text, nothing the assistant produced.
  constraint exec_messages_user_row_check check (
    role = 'assistant' or (
      status = 'complete' and char_length(text) between 1 and 4000 and recommendations = ''
      and jsonb_array_length(sources) = 0 and jsonb_array_length(cards) = 0 and jsonb_array_length(tool_calls) = 0
      and cardinality(consulted_email_thread_ids) = 0 and cardinality(consulted_client_ids) = 0 and not consulted_dd_text
      and usage is null and model is null and redacted_at is null)),
  constraint exec_messages_context_role_check check (role = 'user' or context is null),
  constraint exec_messages_running_check check ((status = 'running') = (finished_at is null)),
  constraint exec_messages_running_role_check check (status <> 'running' or role = 'assistant'),
  constraint exec_messages_redacted_check check (redacted_at is null or (role = 'assistant' and status <> 'running'))
);
-- One running answer per conversation (B5): a second turn while one runs is a 409.
create unique index if not exists exec_messages_one_running_key on public.exec_messages (conversation_id) where status = 'running';
create unique index if not exists exec_messages_slack_ts_key on public.exec_messages (principal_id, slack_ts) where slack_ts is not null;
create index if not exists exec_messages_conversation_idx on public.exec_messages (conversation_id, created_at, id);
-- The chat rate limit (S2, C49): his questions in the last 10 minutes, any surface.
create index if not exists exec_messages_rate_idx on public.exec_messages (principal_id, created_at desc) where role = 'user';
-- Redaction and the draft purge: answers that consulted any of a set of threads
-- (all rows: an already-redacted answer is still processed, C20).
create index if not exists exec_messages_consulted_idx
  on public.exec_messages using gin (consulted_email_thread_ids);
create index if not exists exec_messages_running_idx on public.exec_messages (created_at) where status = 'running';
-- C49: running answers per principal; C21 (5): earlier answers of a conversation redacted during a turn.
create index if not exists exec_messages_principal_running_idx on public.exec_messages (principal_id) where status = 'running';
create index if not exists exec_messages_redacted_idx
  on public.exec_messages (conversation_id, redacted_at) where redacted_at is not null;
create index if not exists exec_messages_expires_idx on public.exec_messages (expires_at);

-- ---------------------------------------------------------------------------
-- Staged tasks
-- ---------------------------------------------------------------------------

create table if not exists public.exec_task_proposals (
  id               text primary key default ('etp_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id     text not null references public.exec_principals(id) on delete cascade,
  conversation_id  text not null references public.exec_conversations(id) on delete cascade,
  message_id       text not null references public.exec_messages(id) on delete cascade,
  status           text not null default 'pending'
                     constraint exec_task_proposals_status_check
                     check (status in ('pending', 'confirming', 'confirmed', 'dismissed', 'withdrawn')),
  title            text not null constraint exec_task_proposals_title_check check (char_length(title) between 1 and 200),
  description      text not null default ''
                     constraint exec_task_proposals_description_check check (char_length(description) <= 4000),
  assignee_user_id text constraint exec_task_proposals_assignee_check
                     check (assignee_user_id is null or char_length(assignee_user_id) between 1 and 100),
  assignee_name    text constraint exec_task_proposals_assignee_name_check
                     check (assignee_name is null or char_length(assignee_name) <= 120),
  department_id    text constraint exec_task_proposals_department_check
                     check (department_id is null or char_length(department_id) between 1 and 100),
  due_on           date,
  due_at           timestamptz,
  client_name      text constraint exec_task_proposals_client_check
                     check (client_name is null or char_length(client_name) between 1 and 200),
  priority         text not null constraint exec_task_proposals_priority_check check (priority in ('low', 'medium', 'high', 'critical')),
  task_id          text constraint exec_task_proposals_task_id_check check (task_id is null or char_length(task_id) between 3 and 100),
  decided_at       timestamptz,
  -- Set when a redaction cleared the content (C20): pending -> withdrawn; any other status keeps it.
  redacted_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  constraint exec_task_proposals_due_check check ((due_on is null) = (due_at is null)),
  constraint exec_task_proposals_state_check check (
       (status = 'pending'    and task_id is null     and decided_at is null)
    or (status = 'confirming' and task_id is not null and decided_at is null)
    or (status = 'confirmed'  and task_id is not null and decided_at is not null)
    or (status in ('dismissed', 'withdrawn') and task_id is null and decided_at is not null)),
  -- Only a redaction withdraws, and a redacted row holds no content (b-security-9).
  constraint exec_task_proposals_withdrawn_check check (status <> 'withdrawn' or redacted_at is not null),
  constraint exec_task_proposals_redacted_check check (redacted_at is null or (title = '[Removed]' and description = ''))
);
create unique index if not exists exec_task_proposals_task_key on public.exec_task_proposals (task_id) where task_id is not null;
create index if not exists exec_task_proposals_message_idx on public.exec_task_proposals (principal_id, message_id);
-- The proposal rate limit: confirms and dismisses in the last 10 minutes.
create index if not exists exec_task_proposals_decided_idx
  on public.exec_task_proposals (principal_id, decided_at desc) where decided_at is not null;

-- ---------------------------------------------------------------------------
-- RPC 1: exec_chat_begin_turn
-- ---------------------------------------------------------------------------
-- One transaction under a per-principal lock: the principal-wide stale sweep,
-- find the conversation, the idempotency and concurrency checks, the
-- principal-wide running and rate checks (C49), then create the conversation if
-- needed, both rows and the context ref.

drop function if exists public.exec_chat_begin_turn(text, text, text, text, text, jsonb, text, integer, integer);
drop function if exists public.exec_chat_begin_turn(text, text, text, text, text, jsonb, text, integer, integer, integer, integer, integer);
create or replace function public.exec_chat_begin_turn(
  p_principal           text,
  p_conversation_id     text,     -- null: start a new conversation
  p_client_turn_id      text,
  p_surface             text,     -- 'web' | 'slack'
  p_user_text           text,     -- 1..4000 characters, already trimmed by the app
  p_context             jsonb,    -- null or { "kind": ..., "id": ... }
  p_title               text,     -- used only when a conversation is created
  p_retention_days      integer,  -- exec_settings.retention_days_chat
  p_stale_seconds       integer,  -- 600
  p_rate_limit          integer,  -- 30 questions ...
  p_rate_window_seconds integer,  -- ... per 600 s, any surface (S2)
  p_max_running         integer   -- 2 running answers per principal (C49)
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now        timestamptz := now();
  v_days       integer := least(greatest(coalesce(p_retention_days, 90), 1), 3650);
  v_stale      integer := least(greatest(coalesce(p_stale_seconds, 600), 60), 3600);
  v_limit      integer := least(greatest(coalesce(p_rate_limit, 30), 1), 1000);
  v_window     integer := least(greatest(coalesce(p_rate_window_seconds, 600), 60), 86400);
  v_max_run    integer := least(greatest(coalesce(p_max_running, 2), 1), 10);
  v_expires    timestamptz;
  v_conv       public.exec_conversations%rowtype;
  v_found      boolean := false;
  v_created    boolean := false;
  v_existing   public.exec_messages%rowtype;
  v_running    integer;
  v_nth        timestamptz;
  v_user_id    text;
  v_user_at    timestamptz;
  v_asst_id    text;
  v_turn       text;
  v_ctx        jsonb := null;
  v_ctx_ref    text := null;
begin
  if p_principal is null or btrim(p_principal) = '' then raise exception 'exec_chat_begin_turn: p_principal is required'; end if;
  if p_client_turn_id is null or char_length(p_client_turn_id) not between 8 and 100 then
    raise exception 'exec_chat_begin_turn: p_client_turn_id must be 8-100 characters';
  end if;
  if p_surface is null or p_surface not in ('web', 'slack') then raise exception 'exec_chat_begin_turn: bad surface %', p_surface; end if;
  if p_user_text is null or char_length(p_user_text) not between 1 and 4000 then
    raise exception 'exec_chat_begin_turn: p_user_text must be 1-4000 characters';
  end if;
  if p_context is not null and (jsonb_typeof(p_context) <> 'object'
      or coalesce(p_context->>'kind', '') not in ('attention', 'project', 'client', 'thread')
      or char_length(coalesce(p_context->>'id', '')) not between 1 and 200) then
    raise exception 'exec_chat_begin_turn: bad context';
  end if;
  v_expires := v_now + make_interval(days => v_days);

  -- One begin at a time per principal (C49): the running count and the rate count below are
  -- then exact, and two tabs (or a tab and a Slack DM) can't both slip under them.
  perform pg_advisory_xact_lock(hashtext('exec-chat:' || p_principal));

  -- A running answer whose process died can't hold anything forever (B5): principal-wide,
  -- so a dead turn in another conversation doesn't count toward p_max_running either.
  update public.exec_messages
     set status = 'failed', status_reason = 'stale', finished_at = v_now, updated_at = v_now
   where principal_id = p_principal and status = 'running'
     and created_at < v_now - make_interval(secs => v_stale);

  if p_conversation_id is null then
    select * into v_conv from public.exec_conversations
     where principal_id = p_principal and create_client_turn_id = p_client_turn_id
     for update;
    v_found := found;
  else
    select * into v_conv from public.exec_conversations
     where id = p_conversation_id and principal_id = p_principal
     for update;
    if not found or v_conv.surface <> p_surface then
      return jsonb_build_object('outcome', 'not_found');
    end if;
    v_found := true;
  end if;

  if v_found then
    -- Idempotency (B5): the same client turn id never runs twice. A replay is answered even
    -- when the principal is at a limit below.
    select * into v_existing from public.exec_messages
     where conversation_id = v_conv.id and client_turn_id = p_client_turn_id and role = 'assistant';
    if found then
      if v_existing.status = 'running' then
        return jsonb_build_object('outcome', 'busy', 'conversation_id', v_conv.id);
      end if;
      return jsonb_build_object('outcome', 'replay', 'conversation_id', v_conv.id, 'turn_id', v_existing.turn_id,
                                'assistant_message_id', v_existing.id);
    end if;
    if exists (select 1 from public.exec_messages where conversation_id = v_conv.id and status = 'running') then
      return jsonb_build_object('outcome', 'busy', 'conversation_id', v_conv.id);
    end if;
  end if;

  -- Principal-wide limits (C49, S2), checked before anything is created, so a refused
  -- first question leaves no empty conversation behind.
  select count(*) into v_running from public.exec_messages
   where principal_id = p_principal and status = 'running';
  if v_running >= v_max_run then
    return jsonb_build_object('outcome', 'busy_principal');
  end if;
  select m.created_at into v_nth from public.exec_messages m
   where m.principal_id = p_principal and m.role = 'user'
     and m.created_at >= v_now - make_interval(secs => v_window)
   order by m.created_at desc
   offset v_limit - 1 limit 1;
  if found then
    return jsonb_build_object('outcome', 'rate_limited', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_nth + make_interval(secs => v_window) - v_now)))::integer));
  end if;

  if not v_found then
    -- No unique_violation handler: the advisory lock serializes every begin of this principal,
    -- so the create_client_turn_id key can't race here (a violation would be a bug and raises).
    insert into public.exec_conversations (principal_id, surface, title, create_client_turn_id, expires_at)
    values (p_principal, p_surface, left(coalesce(nullif(btrim(p_title), ''), 'Conversation'), 120), p_client_turn_id, v_expires)
    returning * into v_conv;
    v_created := true;
  end if;

  -- The context, when there is one, takes the turn's first ref (C18).
  if p_context is not null then
    v_ctx_ref := 'r' || (v_conv.ref_seq + 1)::text;
    v_ctx := jsonb_build_object('kind', p_context->>'kind', 'id', p_context->>'id', 'ref', v_ctx_ref);
  end if;

  v_turn := 'ect_' || replace(gen_random_uuid()::text, '-', '');
  insert into public.exec_messages (principal_id, conversation_id, turn_id, role, client_turn_id, status, text, context,
                                    finished_at, expires_at)
  values (p_principal, v_conv.id, v_turn, 'user', p_client_turn_id, 'complete', p_user_text, v_ctx, v_now, v_expires)
  returning id, created_at into v_user_id, v_user_at;
  insert into public.exec_messages (principal_id, conversation_id, turn_id, role, client_turn_id, status, expires_at)
  values (p_principal, v_conv.id, v_turn, 'assistant', p_client_turn_id, 'running', v_expires)
  returning id into v_asst_id;

  update public.exec_conversations
     set last_message_at = v_now,
         turn_count      = turn_count + 1,
         ref_seq         = ref_seq + (case when v_ctx_ref is null then 0 else 1 end),
         updated_at      = v_now,
         expires_at      = greatest(expires_at, v_expires)
   where id = v_conv.id;

  return jsonb_build_object(
    'outcome', 'started', 'conversation_id', v_conv.id, 'created', v_created, 'turn_id', v_turn,
    'user_message_id', v_user_id, 'user_created_at', v_user_at, 'assistant_message_id', v_asst_id,
    'ref_seq', v_conv.ref_seq + (case when v_ctx_ref is null then 0 else 1 end), 'context_ref', v_ctx_ref);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 2: exec_chat_finish_turn (CAS running -> final, and the conversation's ref_seq)
-- ---------------------------------------------------------------------------
-- Code keeps every value inside its CHECK (C40, C41, C14, the 40,000 clip with the note reserved).

drop function if exists public.exec_chat_finish_turn(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], jsonb, text, integer);
drop function if exists public.exec_chat_finish_turn(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], text[], boolean, jsonb, text, integer);
create or replace function public.exec_chat_finish_turn(
  p_principal          text,
  p_message_id         text,
  p_status             text,
  p_status_reason      text,
  p_refusal_category   text,
  p_text               text,
  p_recommendations    text,
  p_sources            jsonb,
  p_cards              jsonb,
  p_tool_calls         jsonb,
  p_consulted          text[],
  p_consulted_clients  text[],
  p_consulted_dd_text  boolean,
  p_usage              jsonb,
  p_model              text,
  p_ref_seq            integer
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now  timestamptz := now();
  v_conv text;
begin
  if p_status is null or p_status not in ('complete', 'aborted', 'refused', 'failed', 'capped') then
    raise exception 'exec_chat_finish_turn: bad status %', p_status;
  end if;
  update public.exec_messages m
     set status = p_status, status_reason = p_status_reason, refusal_category = p_refusal_category,
         text = coalesce(p_text, ''), recommendations = coalesce(p_recommendations, ''),
         sources = coalesce(p_sources, '[]'::jsonb), cards = coalesce(p_cards, '[]'::jsonb),
         tool_calls = coalesce(p_tool_calls, '[]'::jsonb),
         consulted_email_thread_ids = coalesce(p_consulted, '{}'::text[]),
         consulted_client_ids = coalesce(p_consulted_clients, '{}'::text[]),
         consulted_dd_text = coalesce(p_consulted_dd_text, false),
         usage = p_usage, model = p_model, finished_at = v_now, updated_at = v_now
   where m.id = p_message_id and m.principal_id = p_principal and m.role = 'assistant' and m.status = 'running'
  returning m.conversation_id into v_conv;
  if v_conv is null then return false; end if;
  update public.exec_conversations
     set ref_seq = greatest(ref_seq, least(greatest(coalesce(p_ref_seq, 0), 0), 100000)),
         last_message_at = v_now, updated_at = v_now
   where id = v_conv;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helper: exec_chat_messages_for_threads (C19)
-- ---------------------------------------------------------------------------
-- Every assistant message a tombstone of these threads reaches. Used by RPC 3 and by
-- the draft-id read; running and already-redacted rows are included, and the callers
-- filter. The two rows of a turn share created_at (one transaction, now()), and turns
-- are separate transactions, so "later" is well defined; a tie is included, which
-- fails closed.

drop function if exists public.exec_chat_messages_for_threads(text, text[]);
create or replace function public.exec_chat_messages_for_threads(p_principal text, p_thread_ids text[])
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  with direct as (
    -- (a) the tools consulted one of the threads (the GIN index serves this arm)
    select m.conversation_id, m.created_at
      from public.exec_messages m
     where m.principal_id = p_principal and m.role = 'assistant'
       and m.consulted_email_thread_ids && p_thread_ids
    union all
    -- (b) B7's predicate as a backstop: a cited source points at one of the threads. A source with
    -- no thread (a task, a client) never matches: its coalesce is NULL, and so is "= any".
    select m.conversation_id, m.created_at
      from public.exec_messages m
     where m.principal_id = p_principal and m.role = 'assistant'
       and exists (
         select 1 from jsonb_array_elements(m.sources) as s(e)
          where coalesce(s.e #>> '{target,threadId}',
                         case when s.e #>> '{target,type}' = 'email_thread' then s.e #>> '{target,id}' end)
                = any (p_thread_ids))
  ), first_hit as (
    select d.conversation_id, min(d.created_at) as at from direct d group by d.conversation_id
  )
  -- (c) the hit answers and every later answer of the same conversation (each replayed a hit answer).
  select m.id
    from public.exec_messages m
    join first_hit f on f.conversation_id = m.conversation_id
   where m.principal_id = p_principal and m.role = 'assistant' and m.created_at >= f.at
$$;

-- ---------------------------------------------------------------------------
-- RPC 3: exec_chat_redact_threads (B7 + C19/C20)
-- ---------------------------------------------------------------------------
-- Called by P3's tombstone procedure, its safety nets and the post-finish screen with
-- VERIFIED ids only (C21). Data-modifying CTEs run exactly once whether or not the outer
-- query reads them; all of them see the same snapshot, and `withdrawn` and `cleared`
-- touch disjoint proposal rows.

drop function if exists public.exec_chat_redact_threads(text, text[], text);
create or replace function public.exec_chat_redact_threads(p_principal text, p_thread_ids text[], p_text text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  n     integer := 0;
begin
  if p_principal is null or p_thread_ids is null or cardinality(p_thread_ids) = 0 then return 0; end if;
  if cardinality(p_thread_ids) > 200 then raise exception 'exec_chat_redact_threads: at most 200 thread ids per call'; end if;
  if p_text is null or char_length(p_text) not between 1 and 400 then raise exception 'exec_chat_redact_threads: bad text'; end if;

  with hits as (
    select m.id
      from public.exec_messages m
     where m.id in (select h from public.exec_chat_messages_for_threads(p_principal, p_thread_ids) as h)
       and m.principal_id = p_principal and m.status <> 'running'
  ), changed as (
    -- Already-redacted rows are processed too (C20): a verified tombstone replaces an "unchecked"
    -- text, and leftover sources or arguments are cleared. A fully redacted row is skipped, so the
    -- call is idempotent and returns 0 the second time.
    update public.exec_messages m
       set text = p_text,
           recommendations = '',
           sources = '[]'::jsonb,
           tool_calls = coalesce((
             select jsonb_agg(jsonb_build_object('round', t.e->'round', 'name', t.e->'name', 'ok', t.e->'ok',
                                                 'error', t.e->'error') order by t.o)
               from jsonb_array_elements(m.tool_calls) with ordinality as t(e, o)), '[]'::jsonb),
           redacted_at = coalesce(m.redacted_at, v_now),
           updated_at = v_now
     where m.id in (select id from hits)
       and (m.redacted_at is null or m.text <> p_text or m.recommendations <> '' or m.sources <> '[]'::jsonb
            or exists (select 1 from jsonb_array_elements(m.tool_calls) as a(e) where a.e ? 'args'))
    returning m.id
  ), withdrawn as (
    update public.exec_task_proposals p
       set status = 'withdrawn', title = '[Removed]', description = '', decided_at = v_now,
           redacted_at = v_now, updated_at = v_now
     where p.principal_id = p_principal and p.status = 'pending' and p.message_id in (select id from hits)
    returning p.id
  ), cleared as (
    -- Confirming, confirmed and dismissed proposals keep their status and task id (a created DD task is
    -- his); only the exec copy of the text goes (b-security-9). A confirming row is finished by the confirm.
    update public.exec_task_proposals p
       set title = '[Removed]', description = '', redacted_at = v_now, updated_at = v_now
     where p.principal_id = p_principal and p.status in ('confirming', 'confirmed', 'dismissed')
       and p.redacted_at is null and p.message_id in (select id from hits)
    returning p.id
  )
  select count(*) into n from changed;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 4: exec_chat_redact_message (C21 (3)-(5))
-- ---------------------------------------------------------------------------
-- One message, never principal-wide; its own proposals as RPC 3 treats them; never a draft purge.

drop function if exists public.exec_chat_redact_message(text, text, text);
create or replace function public.exec_chat_redact_message(p_principal text, p_message_id text, p_text text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  n     integer := 0;
begin
  if p_principal is null or p_message_id is null then return false; end if;
  if p_text is null or char_length(p_text) not between 1 and 400 then raise exception 'exec_chat_redact_message: bad text'; end if;

  with hit as (
    select m.id from public.exec_messages m
     where m.id = p_message_id and m.principal_id = p_principal and m.role = 'assistant' and m.status <> 'running'
  ), changed as (
    -- An earlier redaction's text wins: a verified REDACTED_TEXT is never replaced by UNCHECKED_TEXT.
    update public.exec_messages m
       set text = case when m.redacted_at is null then p_text else m.text end,
           recommendations = '',
           sources = '[]'::jsonb,
           tool_calls = coalesce((
             select jsonb_agg(jsonb_build_object('round', t.e->'round', 'name', t.e->'name', 'ok', t.e->'ok',
                                                 'error', t.e->'error') order by t.o)
               from jsonb_array_elements(m.tool_calls) with ordinality as t(e, o)), '[]'::jsonb),
           redacted_at = coalesce(m.redacted_at, v_now),
           updated_at = v_now
     where m.id in (select id from hit)
       and (m.redacted_at is null or m.recommendations <> '' or m.sources <> '[]'::jsonb
            or exists (select 1 from jsonb_array_elements(m.tool_calls) as a(e) where a.e ? 'args'))
    returning m.id
  ), withdrawn as (
    update public.exec_task_proposals p
       set status = 'withdrawn', title = '[Removed]', description = '', decided_at = v_now,
           redacted_at = v_now, updated_at = v_now
     where p.principal_id = p_principal and p.status = 'pending' and p.message_id in (select id from hit)
    returning p.id
  ), cleared as (
    update public.exec_task_proposals p
       set title = '[Removed]', description = '', redacted_at = v_now, updated_at = v_now
     where p.principal_id = p_principal and p.status in ('confirming', 'confirmed', 'dismissed')
       and p.redacted_at is null and p.message_id in (select id from hit)
    returning p.id
  )
  select count(*) into n from changed;
  return n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- P4's exec_drafts + chat_message_id (review security-2; a C20 amendment)
-- ---------------------------------------------------------------------------
-- The answer whose create_draft wrote the draft. P4's successor of a chat draft (T43 /
-- T45) copies it, so the purge by id reaches the successor, which no card names; so is
-- a draft whose create_draft call timed out after the insert (no card was pushed).
-- Null for every web draft. Added before the read below, which names it.

alter table public.exec_drafts add column if not exists chat_message_id text;
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_drafts'::regclass and conname = 'exec_drafts_chat_message_id_check') then
    alter table public.exec_drafts add constraint exec_drafts_chat_message_id_check
      check (chat_message_id is null or chat_message_id ~ '^ecm_[0-9a-f]{32}$');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Read: exec_chat_draft_ids_for_threads (C20)
-- ---------------------------------------------------------------------------
-- The chat drafts of every message RPC 3 reaches (redacted or not): the ones on its
-- cards, and (security-2) every draft linked to it by chat_message_id.

drop function if exists public.exec_chat_draft_ids_for_threads(text, text[]);
create or replace function public.exec_chat_draft_ids_for_threads(p_principal text, p_thread_ids text[])
returns text[]
language sql
stable
security invoker
set search_path = ''
as $$
  with hit as (
    select h from public.exec_chat_messages_for_threads(p_principal, p_thread_ids) as h
  )
  select coalesce(array_agg(distinct x.id), '{}'::text[])
    from (
      select c.e ->> 'id' as id
        from public.exec_messages m
        cross join lateral jsonb_array_elements(m.cards) as c(e)
       where m.id in (select h from hit)
         and m.principal_id = p_principal
         and c.e ->> 'kind' = 'draft'
         and coalesce(c.e ->> 'id', '') ~ '^ed_[0-9a-f]{32}$'
      union all
      select d.id
        from public.exec_drafts d
       where d.principal_id = p_principal
         and d.chat_message_id in (select h from hit)
    ) x
$$;

-- ---------------------------------------------------------------------------
-- RPC 5: exec_drafts_purge_by_ids (C20, P5b contract section 3.23 F8; P4's table)
-- ---------------------------------------------------------------------------
-- P4's restricted purge applied to chosen CHAT drafts by id, because a chat draft can
-- quote a thread other than its own (P4's exec_drafts_purge_restricted keys on the
-- draft's own thread). The set list is P4's C12 list verbatim (copied from P4's final
-- migration), plus last_error_code = 'chat_source_restricted' so P4's page can say why.
-- Only chat-written rows are touched: origin = 'chat', or (security-2) linked to the
-- answer that wrote them (P4's successor of a chat draft has origin 'web'). A card with
-- existing: true can point at a web draft the chat didn't write, which is neither.

drop function if exists public.exec_drafts_purge_by_ids(text, text[]);
create or replace function public.exec_drafts_purge_by_ids(p_principal text, p_draft_ids text[])
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
  v_days integer;
begin
  if p_principal is null then
    raise exception 'exec_drafts_purge_by_ids: p_principal is required';
  end if;
  if p_draft_ids is null or cardinality(p_draft_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_draft_ids) > 200 then
    raise exception 'exec_drafts_purge_by_ids: at most 200 draft ids per call';
  end if;
  select coalesce(max(s.retention_days_email), 180) into v_days
    from public.exec_settings s where s.principal_id = p_principal;

  with u as (
    update public.exec_drafts d
       set status = case
                      when d.outlook_graph_id is null and d.status in ('generating', 'generation_failed', 'draft') then 'discarded'
                      when d.status = 'generating' then coalesce(d.prior_status, 'draft')
                      else d.status
                    end,
           terminal_at = case
                           when d.outlook_graph_id is null and d.status in ('generating', 'generation_failed', 'draft')
                             then coalesce(d.terminal_at, now())
                           else d.terminal_at
                         end,
           expires_at = case
                          when d.outlook_graph_id is null and d.status in ('generating', 'generation_failed', 'draft')
                            then coalesce(d.expires_at, now() + make_interval(days => v_days))
                          else d.expires_at
                        end,
           next_check_at = case when d.status in ('generating', 'generation_failed', 'draft') then null else d.next_check_at end,
           prior_status = case when d.status = 'discarding' then d.prior_status else null end,
           thread_subject = null, reply_candidates = null, thread_addresses = '{}',
           to_recipients = '[]'::jsonb, cc_recipients = '[]'::jsonb, bcc_recipients = '[]'::jsonb,
           subject = null, body_doc = null, body_html = null, body_text = null,
           instruction = null, note_for_mitchell = null, placeholders = '{}', review_recipients = null,
           review_hash = null, review_at = null, review_blockers = '{}',
           restricted_purged = true,
           content_purged_at = coalesce(d.content_purged_at, now()),
           last_error_code = 'chat_source_restricted', last_error_at = now(),
           version = d.version + 1,
           updated_at = now()
     where d.principal_id = p_principal
       and d.id = any(p_draft_ids)
       and (d.origin = 'chat' or d.chat_message_id is not null)
       and not d.restricted_purged
    returning 1
  )
  select count(*)::int into n from u;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 6: exec_chat_purge_expired_messages (review loop-3; a C19 / section 2.3 amendment)
-- ---------------------------------------------------------------------------
-- Messages expire one by one, by their own expires_at, while their conversation lives
-- on. An answer that consulted or cited a thread is where RPC 3 finds that thread's
-- first hit in a conversation (arms a, b), and arm c then reaches every later answer,
-- each of which replayed it. So before an expired answer is deleted, its thread ids
-- (consulted, and its sources' threads) are carried into the earliest surviving later
-- answer of the same conversation: the first hit moves forward, and every answer that
-- could have restated the deleted one stays reachable. Fail closed: when the union
-- wouldn't fit the 600 CHECK, that answer and every later one of the conversation are
-- hidden with p_text (RPC 4, proposals included). A conversation with a running answer
-- is left for the next run (that answer's finish writes its consulted ids). Rows of an
-- expired conversation are the cascade's (the conversation purge runs first). Returns
-- the number of messages deleted (questions and answers).

drop function if exists public.exec_chat_purge_expired_messages(timestamptz, text);
create or replace function public.exec_chat_purge_expired_messages(p_now timestamptz, p_text text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer := 0;
  r record;
begin
  if p_now is null then raise exception 'exec_chat_purge_expired_messages: p_now is required'; end if;
  if p_text is null or char_length(p_text) not between 1 and 400 then raise exception 'exec_chat_purge_expired_messages: bad text'; end if;

  for r in
    with expiring as (
      select m.conversation_id, m.created_at,
             m.consulted_email_thread_ids || array(
               select coalesce(s.e #>> '{target,threadId}',
                               case when s.e #>> '{target,type}' = 'email_thread' then s.e #>> '{target,id}' end)
                 from jsonb_array_elements(m.sources) as s(e)) as threads
        from public.exec_messages m
        join public.exec_conversations c on c.id = m.conversation_id
       where m.role = 'assistant' and m.status <> 'running' and m.expires_at < p_now and c.expires_at >= p_now
         and not exists (select 1 from public.exec_messages q where q.conversation_id = m.conversation_id and q.status = 'running')
    ), carried as (
      select t.id, array_agg(distinct th) filter (where th is not null) as threads
        from expiring e
        cross join lateral (
          select s.id from public.exec_messages s
           where s.conversation_id = e.conversation_id and s.role = 'assistant'
             and s.expires_at >= p_now and s.created_at > e.created_at
           order by s.created_at, s.id
           limit 1) t
        cross join lateral unnest(e.threads) as th
       group by t.id
    )
    select m.id, m.principal_id, m.conversation_id, m.created_at,
           array(select distinct x from unnest(m.consulted_email_thread_ids || coalesce(c.threads, '{}'::text[])) as x order by 1) as threads
      from carried c join public.exec_messages m on m.id = c.id
     order by m.conversation_id, m.created_at, m.id
  loop
    if cardinality(r.threads) <= 600 then
      update public.exec_messages m
         set consulted_email_thread_ids = r.threads, updated_at = now()
       where m.id = r.id;
    else
      perform public.exec_chat_redact_message(x.principal_id, x.id, p_text)
         from public.exec_messages x
        where x.conversation_id = r.conversation_id and x.role = 'assistant' and x.status <> 'running'
          and x.created_at >= r.created_at;
    end if;
  end loop;

  with gone as (
    delete from public.exec_messages m
     where m.expires_at < p_now
       and not exists (select 1 from public.exec_messages q where q.conversation_id = m.conversation_id and q.status = 'running')
    returning 1
  )
  select count(*)::int into n from gone;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- P4's review blocker list + 'private_refs' (section 3.23 F4)
-- ---------------------------------------------------------------------------
-- P4's column constraint keeps its name, which P4's grid row checks along with its v2
-- values; the list is P4's final REVIEW_BLOCKERS plus 'private_refs'. Re-adding
-- validates the existing rows, which all hold a subset of the old list.

alter table public.exec_drafts drop constraint if exists exec_drafts_review_blockers_check;
alter table public.exec_drafts add constraint exec_drafts_review_blockers_check check (review_blockers <@ array[
  'already_replied', 'newer_inbound', 'reply_scheduled', 'legacy_draft_pending', 'opened_in_outlook',
  'changed_in_outlook', 'recipients_changed', 'reply_to_present', 'placeholder_in_outlook', 'thread_unavailable',
  'facts_outside_client', 'unexpected_content', 'private_refs']::text[]);

-- ---------------------------------------------------------------------------
-- P4's exec_drafts + instruction_by (section 3.23 F7, C44)
-- ---------------------------------------------------------------------------
-- Existing rows are web drafts with his own instructions, so the default 'owner' is
-- their truth; createChatReplyDraft writes 'assistant'.

alter table public.exec_drafts add column if not exists instruction_by text not null default 'owner';
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.exec_drafts'::regclass and conname = 'exec_drafts_instruction_by_check') then
    alter table public.exec_drafts add constraint exec_drafts_instruction_by_check
      check (instruction_by in ('owner', 'assistant'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, no policies; service_role only
-- ---------------------------------------------------------------------------

alter table public.exec_conversations  enable row level security;
alter table public.exec_messages       enable row level security;
alter table public.exec_task_proposals enable row level security;
revoke all on public.exec_conversations, public.exec_messages, public.exec_task_proposals from public, anon, authenticated;
grant all on public.exec_conversations, public.exec_messages, public.exec_task_proposals to service_role;

revoke all on function public.exec_chat_begin_turn(text, text, text, text, text, jsonb, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.exec_chat_finish_turn(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], text[], boolean, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.exec_chat_messages_for_threads(text, text[]) from public, anon, authenticated;
revoke all on function public.exec_chat_redact_threads(text, text[], text) from public, anon, authenticated;
revoke all on function public.exec_chat_redact_message(text, text, text) from public, anon, authenticated;
revoke all on function public.exec_chat_draft_ids_for_threads(text, text[]) from public, anon, authenticated;
revoke all on function public.exec_drafts_purge_by_ids(text, text[]) from public, anon, authenticated;
revoke all on function public.exec_chat_purge_expired_messages(timestamptz, text) from public, anon, authenticated;
grant execute on function public.exec_chat_begin_turn(text, text, text, text, text, jsonb, text, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.exec_chat_finish_turn(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, text[], text[], boolean, jsonb, text, integer) to service_role;
grant execute on function public.exec_chat_messages_for_threads(text, text[]) to service_role;
grant execute on function public.exec_chat_redact_threads(text, text[], text) to service_role;
grant execute on function public.exec_chat_redact_message(text, text, text) to service_role;
grant execute on function public.exec_chat_draft_ids_for_threads(text, text[]) to service_role;
grant execute on function public.exec_drafts_purge_by_ids(text, text[]) to service_role;
grant execute on function public.exec_chat_purge_expired_messages(timestamptz, text) to service_role;

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
--   * the three exec_settings columns (type, not null, default) and the cap CHECK;
--   * every column of the three new tables, with type and nullability, and the
--     column defaults the app relies on;
--   * every named CHECK (a few by the words their definition must hold), the
--     two unique keys and the three primary keys by columns;
--   * every index by its definition (the text after " USING ") and uniqueness;
--   * the six foreign keys with ON DELETE CASCADE, by columns and target;
--   * the eight functions: SECURITY INVOKER with search_path pinned to '', and
--     one signature each of the begin and finish RPCs;
--   * P4's pieces: the review-blocker CHECK holds 'private_refs' (and P4's v2
--     values), exec_drafts.instruction_by with its CHECK, and the nullable
--     exec_drafts.chat_message_id with its CHECK (security-2).
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
  select 'column: ' || e.tbl || '.' || e.col || ' ' || e.typ || ' not null default ' || e.def,
         coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_settings', 'chat_enabled', 'boolean', 'false'),
    ('exec_settings', 'ask_ai_uses_exec', 'boolean', 'false'),
    ('exec_settings', 'chat_daily_cap_usd', 'numeric(10,2)', '9'),
    ('exec_drafts', 'instruction_by', 'text', '''owner''::text')
  ) e(tbl, col, typ, def)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = e.typ and a.attnotnull
             and pg_get_expr(d.adbin, d.adrelid) = e.def as ok,
           format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ' (no default)') as found
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = e.col and not a.attisdropped
  ) x on true
  union all
  select 'column: exec_drafts.chat_message_id text (nullable, no default)', coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values (1)) e(one)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = 'text' and not a.attnotnull and d.adbin is null as ok,
           format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ' (no default)') as found
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = to_regclass('public.exec_drafts') and a.attname = 'chat_message_id' and not a.attisdropped
  ) x on true
  union all
  select 'check: ' || e.name, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.def, '(missing)') end
  from (values
    ('exec_settings', 'exec_settings_chat_daily_cap_check', array['chat_daily_cap_usd']),
    ('exec_drafts', 'exec_drafts_instruction_by_check', array['owner', 'assistant']),
    ('exec_drafts', 'exec_drafts_review_blockers_check', array['private_refs', 'facts_outside_client', 'unexpected_content']),
    ('exec_drafts', 'exec_drafts_chat_message_id_check', array['chat_message_id', 'ecm_'])
  ) e(tbl, name, needs)
  left join lateral (
    select not exists (select 1 from unnest(e.needs) w where pg_get_constraintdef(pc.oid) !~ ('\m' || w || '\M')) as ok,
           pg_get_constraintdef(pc.oid) as def
    from pg_constraint pc
    where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = e.name
  ) x on true
  union all
  select 'columns: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_conversations'), ('exec_messages'), ('exec_task_proposals')) e(tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_conversations', 1, 'id', 'text', true), ('exec_conversations', 2, 'principal_id', 'text', true),
      ('exec_conversations', 3, 'surface', 'text', true), ('exec_conversations', 4, 'title', 'text', true),
      ('exec_conversations', 5, 'create_client_turn_id', 'text', true), ('exec_conversations', 6, 'slack_channel_id', 'text', false),
      ('exec_conversations', 7, 'slack_thread_ts', 'text', false), ('exec_conversations', 8, 'ref_seq', 'integer', true),
      ('exec_conversations', 9, 'turn_count', 'integer', true),
      ('exec_conversations', 10, 'last_message_at', 'timestamp with time zone', true),
      ('exec_conversations', 11, 'created_at', 'timestamp with time zone', true),
      ('exec_conversations', 12, 'updated_at', 'timestamp with time zone', true),
      ('exec_conversations', 13, 'expires_at', 'timestamp with time zone', true),
      ('exec_messages', 1, 'id', 'text', true), ('exec_messages', 2, 'principal_id', 'text', true),
      ('exec_messages', 3, 'conversation_id', 'text', true), ('exec_messages', 4, 'turn_id', 'text', true),
      ('exec_messages', 5, 'role', 'text', true), ('exec_messages', 6, 'client_turn_id', 'text', true),
      ('exec_messages', 7, 'status', 'text', true), ('exec_messages', 8, 'status_reason', 'text', false),
      ('exec_messages', 9, 'refusal_category', 'text', false), ('exec_messages', 10, 'text', 'text', true),
      ('exec_messages', 11, 'recommendations', 'text', true), ('exec_messages', 12, 'context', 'jsonb', false),
      ('exec_messages', 13, 'sources', 'jsonb', true), ('exec_messages', 14, 'cards', 'jsonb', true),
      ('exec_messages', 15, 'tool_calls', 'jsonb', true), ('exec_messages', 16, 'consulted_email_thread_ids', 'text[]', true),
      ('exec_messages', 17, 'consulted_client_ids', 'text[]', true), ('exec_messages', 18, 'consulted_dd_text', 'boolean', true),
      ('exec_messages', 19, 'usage', 'jsonb', false), ('exec_messages', 20, 'model', 'text', false),
      ('exec_messages', 21, 'slack_ts', 'text', false), ('exec_messages', 22, 'redacted_at', 'timestamp with time zone', false),
      ('exec_messages', 23, 'created_at', 'timestamp with time zone', true),
      ('exec_messages', 24, 'updated_at', 'timestamp with time zone', true),
      ('exec_messages', 25, 'finished_at', 'timestamp with time zone', false),
      ('exec_messages', 26, 'expires_at', 'timestamp with time zone', true),
      ('exec_task_proposals', 1, 'id', 'text', true), ('exec_task_proposals', 2, 'principal_id', 'text', true),
      ('exec_task_proposals', 3, 'conversation_id', 'text', true), ('exec_task_proposals', 4, 'message_id', 'text', true),
      ('exec_task_proposals', 5, 'status', 'text', true), ('exec_task_proposals', 6, 'title', 'text', true),
      ('exec_task_proposals', 7, 'description', 'text', true), ('exec_task_proposals', 8, 'assignee_user_id', 'text', false),
      ('exec_task_proposals', 9, 'assignee_name', 'text', false), ('exec_task_proposals', 10, 'department_id', 'text', false),
      ('exec_task_proposals', 11, 'due_on', 'date', false), ('exec_task_proposals', 12, 'due_at', 'timestamp with time zone', false),
      ('exec_task_proposals', 13, 'client_name', 'text', false), ('exec_task_proposals', 14, 'priority', 'text', true),
      ('exec_task_proposals', 15, 'task_id', 'text', false),
      ('exec_task_proposals', 16, 'decided_at', 'timestamp with time zone', false),
      ('exec_task_proposals', 17, 'redacted_at', 'timestamp with time zone', false),
      ('exec_task_proposals', 18, 'created_at', 'timestamp with time zone', true),
      ('exec_task_proposals', 19, 'updated_at', 'timestamp with time zone', true),
      ('exec_task_proposals', 20, 'expires_at', 'timestamp with time zone', true)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select 'defaults: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_conversations'), ('exec_messages'), ('exec_task_proposals')) e(tbl)
  cross join lateral (
    select string_agg(k.col || ' default ' || k.def, ', ' order by k.col) as wrong
    from (values
      ('exec_conversations', 'ref_seq', '0'), ('exec_conversations', 'turn_count', '0'),
      ('exec_messages', 'text', '''''::text'), ('exec_messages', 'recommendations', '''''::text'),
      ('exec_messages', 'sources', '''[]''::jsonb'), ('exec_messages', 'cards', '''[]''::jsonb'),
      ('exec_messages', 'tool_calls', '''[]''::jsonb'),
      ('exec_messages', 'consulted_email_thread_ids', '''{}''::text[]'),
      ('exec_messages', 'consulted_client_ids', '''{}''::text[]'), ('exec_messages', 'consulted_dd_text', 'false'),
      ('exec_task_proposals', 'status', '''pending''::text'), ('exec_task_proposals', 'description', '''''::text')
    ) k(tbl, col, def)
    where k.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = k.col and not a.attisdropped
          and pg_get_expr(d.adbin, d.adrelid) = k.def)
  ) x
  union all
  select 'checks: ' || e.tbl, x.missing is null, x.missing
  from (values ('exec_conversations'), ('exec_messages'), ('exec_task_proposals')) e(tbl)
  cross join lateral (
    select string_agg(k.name || case when d.def is null then '' else ' (definition)' end, ', ' order by k.name) as missing
    from (values
      ('exec_conversations_surface_check', null), ('exec_conversations_title_check', null),
      ('exec_conversations_create_turn_check', null), ('exec_conversations_slack_channel_check', null),
      ('exec_conversations_slack_ts_check', null), ('exec_conversations_ref_seq_check', null),
      ('exec_conversations_turn_count_check', null), ('exec_conversations_slack_pair_check', null),
      ('exec_conversations_web_check', null),
      ('exec_messages_turn_id_check', null), ('exec_messages_role_check', null), ('exec_messages_client_turn_check', null),
      ('exec_messages_status_check', null), ('exec_messages_status_reason_check', null),
      ('exec_messages_refusal_category_check', null), ('exec_messages_text_check', null),
      ('exec_messages_recommendations_check', null), ('exec_messages_context_check', null),
      ('exec_messages_sources_check', null), ('exec_messages_cards_check', null), ('exec_messages_tool_calls_check', null),
      ('exec_messages_consulted_check', array['600']), ('exec_messages_consulted_clients_check', array['500']),
      ('exec_messages_usage_check', null), ('exec_messages_model_check', null), ('exec_messages_slack_ts_check', null),
      ('exec_messages_user_row_check', array['consulted_client_ids', 'consulted_dd_text', 'consulted_email_thread_ids']),
      ('exec_messages_context_role_check', null), ('exec_messages_running_check', array['finished_at']),
      ('exec_messages_running_role_check', null), ('exec_messages_redacted_check', array['redacted_at']),
      ('exec_task_proposals_status_check', array['withdrawn']), ('exec_task_proposals_title_check', null),
      ('exec_task_proposals_description_check', null), ('exec_task_proposals_assignee_check', null),
      ('exec_task_proposals_assignee_name_check', null), ('exec_task_proposals_department_check', null),
      ('exec_task_proposals_client_check', null), ('exec_task_proposals_priority_check', null),
      ('exec_task_proposals_task_id_check', null), ('exec_task_proposals_due_check', null),
      ('exec_task_proposals_state_check', array['confirming', 'decided_at']),
      ('exec_task_proposals_withdrawn_check', array['redacted_at']),
      ('exec_task_proposals_redacted_check', array['redacted_at'])
    ) k(name, needs)
    cross join lateral (
      select pg_get_constraintdef(pc.oid) as def
      from pg_constraint pc
      where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = k.name
      union all
      select null::text where not exists (select 1 from pg_constraint pc
                                           where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = k.name)
    ) d
    where starts_with(k.name, e.tbl || '_')
      and (d.def is null
           or (k.needs is not null and exists (select 1 from unnest(k.needs) w where d.def !~ ('\m' || w || '\M'))))
  ) x
  union all
  select e.label, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('primary key: exec_conversations', 'exec_conversations', 'exec_conversations_pkey', 'p', array['id']),
    ('primary key: exec_messages', 'exec_messages', 'exec_messages_pkey', 'p', array['id']),
    ('primary key: exec_task_proposals', 'exec_task_proposals', 'exec_task_proposals_pkey', 'p', array['id']),
    ('unique key: exec_conversations_create_turn_key', 'exec_conversations', 'exec_conversations_create_turn_key', 'u',
     array['principal_id', 'create_client_turn_id']),
    ('unique key: exec_messages_turn_role_key', 'exec_messages', 'exec_messages_turn_role_key', 'u',
     array['conversation_id', 'client_turn_id', 'role'])
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
    ('exec_conversations', array['principal_id'], 'exec_principals'),
    ('exec_messages', array['principal_id'], 'exec_principals'),
    ('exec_messages', array['conversation_id'], 'exec_conversations'),
    ('exec_task_proposals', array['principal_id'], 'exec_principals'),
    ('exec_task_proposals', array['conversation_id'], 'exec_conversations'),
    ('exec_task_proposals', array['message_id'], 'exec_messages')
  ) e(tbl, cols, ref)
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def and x.uniq = e.uniq, false),
         case when not coalesce(x.def = e.def and x.uniq = e.uniq, false)
              then coalesce(case when x.uniq then 'unique ' else '' end || x.def, '(missing)') end
  from (values
    ('exec_conversations', 'exec_conversations_slack_thread_key',
     'btree (principal_id, slack_channel_id, slack_thread_ts) WHERE (slack_thread_ts IS NOT NULL)', true),
    ('exec_conversations', 'exec_conversations_recent_idx', 'btree (principal_id, last_message_at DESC)', false),
    ('exec_conversations', 'exec_conversations_expires_idx', 'btree (expires_at)', false),
    ('exec_messages', 'exec_messages_one_running_key', 'btree (conversation_id) WHERE (status = ''running''::text)', true),
    ('exec_messages', 'exec_messages_slack_ts_key', 'btree (principal_id, slack_ts) WHERE (slack_ts IS NOT NULL)', true),
    ('exec_messages', 'exec_messages_conversation_idx', 'btree (conversation_id, created_at, id)', false),
    ('exec_messages', 'exec_messages_rate_idx', 'btree (principal_id, created_at DESC) WHERE (role = ''user''::text)', false),
    ('exec_messages', 'exec_messages_consulted_idx', 'gin (consulted_email_thread_ids)', false),
    ('exec_messages', 'exec_messages_running_idx', 'btree (created_at) WHERE (status = ''running''::text)', false),
    ('exec_messages', 'exec_messages_principal_running_idx', 'btree (principal_id) WHERE (status = ''running''::text)', false),
    ('exec_messages', 'exec_messages_redacted_idx', 'btree (conversation_id, redacted_at) WHERE (redacted_at IS NOT NULL)', false),
    ('exec_messages', 'exec_messages_expires_idx', 'btree (expires_at)', false),
    ('exec_task_proposals', 'exec_task_proposals_task_key', 'btree (task_id) WHERE (task_id IS NOT NULL)', true),
    ('exec_task_proposals', 'exec_task_proposals_message_idx', 'btree (principal_id, message_id)', false),
    ('exec_task_proposals', 'exec_task_proposals_decided_idx',
     'btree (principal_id, decided_at DESC) WHERE (decided_at IS NOT NULL)', false)
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
    ('exec_chat_begin_turn(text,text,text,text,text,jsonb,text,integer,integer,integer,integer,integer)'),
    ('exec_chat_finish_turn(text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text[],text[],boolean,jsonb,text,integer)'),
    ('exec_chat_messages_for_threads(text,text[])'),
    ('exec_chat_redact_threads(text,text[],text)'),
    ('exec_chat_redact_message(text,text,text)'),
    ('exec_chat_draft_ids_for_threads(text,text[])'),
    ('exec_drafts_purge_by_ids(text,text[])'),
    ('exec_chat_purge_expired_messages(timestamptz,text)')
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
  from (values ('exec_chat_begin_turn'), ('exec_chat_finish_turn')) e(name)
  cross join lateral (
    select count(*)::int as n, string_agg(p.oid::regprocedure::text, '; ') as sigs
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = e.name
  ) x
) checks
order by ok, check_name;
