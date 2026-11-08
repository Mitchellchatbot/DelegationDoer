-- Executive AI Assistant — P6 Slack app (bot-only install, DM chat, App Home).
--
--   exec_slack_installations  the one record of the assistant's Slack install per principal:
--                             ids, the sealed bot token (AES-256-GCM, crypto.ts), the DM channel.
--                             The single source of truth: exec_principals.slack_team_id and
--                             slack_user_id stay unused. P6 stores no user token (CHECKs below;
--                             P7 relaxes them with its re-consent).
--   exec_slack_events         every signed Events API delivery that reached the database, by
--                             event_id: the routing decision and references only, never text.
--                             Kept 25 hours (Slack's Delayed Events window).
--   exec_oauth_states         single-use OAuth state nonces (hashed), 10-minute TTL.
--   exec_chat_feedback        his Useful / Not useful votes on assistant answers.
--   exec_slack_posts          the ledger of every message the bot posted in his DM: ids and ts only.
--                             Drives the redaction follow-up and the DM retention purge.
--   exec_access_log           + slack_user_id, slack_event_id (surface 'slack' rows only).
--
-- RPCs (SECURITY INVOKER, search_path pinned, EXECUTE for service_role only):
--   exec_slack_accept_event            the events ack: dedupe + routing rule + enqueue, one transaction.
--   exec_slack_accept_action           the interactions ack: owner check + enqueue.
--   exec_slack_revoke_installation     mark revoked + enqueue the purge.
--   exec_slack_purge_installation      null the token, delete events, posts and that install's Slack conversations.
--   exec_slack_conversation_for_thread get-or-create the conversation of one DM thread.
--   exec_slack_reply_step              CAS on a DM reply's state; stores the placeholder ts.
--   exec_slack_redaction_followups     posts whose answer was redacted or whose draft was purged since last shown.
--
-- Security: RLS ON with NO policies; nothing granted to anon/authenticated.
-- Idempotent. Apply MANUALLY in the Supabase SQL editor AFTER 20261107100000_exec_chat.sql.
-- Nothing runs until EXEC_ENABLED=true and Mitchell connects Slack in Settings.

set local lock_timeout = '5s';

-- Pre-flight: P2a, and P5b's chat tables (which need P4). Aborts before changing anything.
do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_jobs') is null
     or to_regclass('public.exec_access_log') is null then
    raise exception 'exec slack aborted, nothing changed: the P2a foundation is missing (apply 20261104100000_exec_foundation.sql first)';
  end if;
  if to_regclass('public.exec_conversations') is null or to_regclass('public.exec_messages') is null then
    raise exception 'exec slack aborted, nothing changed: P5b chat is missing (apply 20261107100000_exec_chat.sql first)';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_conversations_create_turn_key') then
    raise exception 'exec slack aborted, nothing changed: exec_conversations_create_turn_key is missing (P5b migration incomplete)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- exec_slack_installations (K6)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_installations (
  id                  text primary key default ('esi_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id        text not null references public.exec_principals(id) on delete cascade,
  team_id             text not null constraint exec_slack_installations_team_check check (team_id ~ '^T[A-Z0-9]{2,30}$'),
  app_id              text not null constraint exec_slack_installations_app_check check (app_id ~ '^A[A-Z0-9]{2,30}$'),
  bot_user_id         text not null constraint exec_slack_installations_bot_user_check check (bot_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  bot_id              text not null constraint exec_slack_installations_bot_id_check check (bot_id ~ '^B[A-Z0-9]{2,30}$'),
  -- sealSecret output v1.<kid>.<iv>.<tag>.<ct> (crypto.ts); null only after the purge.
  bot_token_enc       text constraint exec_slack_installations_token_shape_check
                        check (bot_token_enc is null or bot_token_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  -- = the blob's kid, kept as an index for rotation sweeps.
  key_id              text constraint exec_slack_installations_key_id_check check (key_id is null or key_id ~ '^[0-9a-f]{8}$'),
  bot_scopes          text[] not null default '{}'
                        constraint exec_slack_installations_bot_scopes_check check (cardinality(bot_scopes) <= 50),
  -- His Slack user id (authed_user.id, verified against users.lookupByEmail at install).
  user_id             text not null constraint exec_slack_installations_user_check check (user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  -- P6 is bot-only (K1): P7's re-consent migration relaxes these two CHECKs.
  user_token_enc      text constraint exec_slack_installations_no_user_token check (user_token_enc is null),
  user_scopes         text[] not null default '{}'
                        constraint exec_slack_installations_no_user_scopes check (cardinality(user_scopes) = 0),
  slack_dm_channel_id text not null constraint exec_slack_installations_dm_check check (slack_dm_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  -- Set on every successful install or reinstall (C17's stale-revoke guard compares event_time with it).
  installed_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  revoked_at          timestamptz,
  revoke_reason       text constraint exec_slack_installations_reason_check
                        check (revoke_reason is null or revoke_reason in ('app_uninstalled', 'tokens_revoked', 'disconnected')),
  last_dm_at          timestamptz,
  last_error_code     text constraint exec_slack_installations_error_code_check
                        check (last_error_code is null or last_error_code ~ '^[a-z_]{1,60}$'),
  last_error_at       timestamptz,
  purged_at           timestamptz,
  constraint exec_slack_installations_active_token_check
    check (revoked_at is not null or (bot_token_enc is not null and key_id is not null)),
  constraint exec_slack_installations_revoke_pair_check check ((revoked_at is null) = (revoke_reason is null)),
  constraint exec_slack_installations_error_pair_check check ((last_error_code is null) = (last_error_at is null)),
  constraint exec_slack_installations_purged_check
    check (purged_at is null or (revoked_at is not null and bot_token_enc is null and key_id is null))
);
-- K6: unique while not revoked.
create unique index if not exists exec_slack_installations_active_key
  on public.exec_slack_installations (principal_id) where revoked_at is null;
create unique index if not exists exec_slack_installations_dm_key
  on public.exec_slack_installations (slack_dm_channel_id) where revoked_at is null;
create index if not exists exec_slack_installations_team_idx
  on public.exec_slack_installations (team_id, app_id) where revoked_at is null;
create index if not exists exec_slack_installations_principal_idx
  on public.exec_slack_installations (principal_id, installed_at desc);

-- ---------------------------------------------------------------------------
-- exec_slack_events (K7, C5, C8)
-- ---------------------------------------------------------------------------
-- updated_at: RPC 1 inserts with received_at = updated_at = now() and its job_id update leaves
-- updated_at alone, so a queued row's updated_at is its insert time; every RPC 6 transition sets
-- it. The sweep's 10-minute rule reads "10 minutes after the row last changed state".
--
-- exec_slack_events_reply_refs_check vs installation_id's ON DELETE SET NULL: installations are
-- never deleted on their own (a revoked row stays as the record, C18), and the purge deletes the
-- installation's events before anything else.

create table if not exists public.exec_slack_events (
  event_id             text primary key constraint exec_slack_events_id_check check (event_id ~ '^Ev[A-Za-z0-9]{2,40}$'),
  installation_id      text references public.exec_slack_installations(id) on delete set null,
  principal_id         text references public.exec_principals(id) on delete cascade,
  team_id              text not null constraint exec_slack_events_team_check check (char_length(team_id) between 1 and 40),
  api_app_id           text not null constraint exec_slack_events_app_check check (char_length(api_app_id) between 1 and 40),
  event_type           text not null constraint exec_slack_events_type_check check (event_type ~ '^[a-z_.]{1,60}$'),
  decision             text not null constraint exec_slack_events_decision_check
                         check (decision in ('reply', 'home', 'revoke', 'revoke_check', 'drop')),
  drop_reason          text constraint exec_slack_events_reason_check check (drop_reason is null or drop_reason ~ '^[a-z_]{1,40}$'),
  -- References, reply rows only. Never text.
  channel_id           text constraint exec_slack_events_channel_check check (channel_id is null or channel_id ~ '^D[A-Z0-9]{2,30}$'),
  message_ts           text constraint exec_slack_events_ts_check check (message_ts is null or message_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  thread_ts            text constraint exec_slack_events_thread_check check (thread_ts is null or thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  -- C47: the installation owner's id only; null on every row whose user is anyone else.
  slack_user_id        text constraint exec_slack_events_user_check check (slack_user_id is null or slack_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  event_time           timestamptz not null,
  retry_num            smallint not null default 0 constraint exec_slack_events_retry_check check (retry_num between 0 and 100),
  -- exec_jobs.id of the enqueued job; no FK (finished jobs are purged after 14 days).
  job_id               bigint,
  reply_state          text constraint exec_slack_events_state_check
                         check (reply_state is null or reply_state in ('queued', 'started', 'placeholder', 'answered', 'failed', 'skipped', 'swept')),
  placeholder_ts       text constraint exec_slack_events_placeholder_check
                         check (placeholder_ts is null or placeholder_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  conversation_id      text references public.exec_conversations(id) on delete set null,
  assistant_message_id text references public.exec_messages(id) on delete set null,
  received_at          timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint exec_slack_events_reply_state_check check ((decision = 'reply') = (reply_state is not null)),
  constraint exec_slack_events_drop_check check ((decision = 'drop') = (drop_reason is not null)),
  constraint exec_slack_events_reply_refs_check
    check (decision <> 'reply' or (channel_id is not null and message_ts is not null and principal_id is not null and installation_id is not null)),
  constraint exec_slack_events_placeholder_state_check
    check (placeholder_ts is null or reply_state in ('placeholder', 'answered', 'failed', 'swept'))
);
create index if not exists exec_slack_events_received_idx on public.exec_slack_events (received_at);
-- C8: the sweep judges open replies by their last transition (updated_at), never by received_at.
create index if not exists exec_slack_events_open_idx
  on public.exec_slack_events (principal_id, updated_at) where reply_state in ('queued', 'started', 'placeholder');
create index if not exists exec_slack_events_installation_idx on public.exec_slack_events (installation_id, received_at desc);
-- C42: RPC 7 excludes answers whose reply is still open.
create index if not exists exec_slack_events_message_idx
  on public.exec_slack_events (assistant_message_id) where assistant_message_id is not null;

-- ---------------------------------------------------------------------------
-- exec_oauth_states (C1): keyed by sha256(nonce); the raw nonce never reaches the database
-- ---------------------------------------------------------------------------

create table if not exists public.exec_oauth_states (
  nonce_hash   text primary key constraint exec_oauth_states_hash_check check (nonce_hash ~ '^[0-9a-f]{64}$'),
  provider     text not null constraint exec_oauth_states_provider_check check (provider = 'slack'),
  principal_id text not null references public.exec_principals(id) on delete cascade,
  auth_user_id text not null constraint exec_oauth_states_auth_user_check check (char_length(auth_user_id) between 1 and 128),
  session_id   text not null constraint exec_oauth_states_session_check check (char_length(session_id) between 1 and 128),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint exec_oauth_states_ttl_check check (expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);
create index if not exists exec_oauth_states_expires_idx on public.exec_oauth_states (expires_at);
create index if not exists exec_oauth_states_principal_idx on public.exec_oauth_states (principal_id, provider);

-- ---------------------------------------------------------------------------
-- exec_chat_feedback (C16): his Useful / Not useful votes, one per answer
-- ---------------------------------------------------------------------------

create table if not exists public.exec_chat_feedback (
  principal_id text not null references public.exec_principals(id) on delete cascade,
  message_id   text not null references public.exec_messages(id) on delete cascade,
  vote         smallint not null constraint exec_chat_feedback_vote_check check (vote in (-1, 1)),
  surface      text not null constraint exec_chat_feedback_surface_check check (surface in ('web', 'slack')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint exec_chat_feedback_pkey primary key (principal_id, message_id)
);

-- ---------------------------------------------------------------------------
-- exec_slack_posts (C43): the ledger of every bot post in his DM. No text, no blocks: what a post
-- showed is re-derived from DD's rows when needed (C42).
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_posts (
  installation_id text not null references public.exec_slack_installations(id) on delete cascade,
  principal_id    text not null references public.exec_principals(id) on delete cascade,
  channel_id      text not null constraint exec_slack_posts_channel_check check (channel_id ~ '^D[A-Z0-9]{2,30}$'),
  ts              text not null constraint exec_slack_posts_ts_check check (ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  thread_ts       text constraint exec_slack_posts_thread_check check (thread_ts is null or thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  kind            text not null constraint exec_slack_posts_kind_check check (kind in ('answer', 'note', 'draft', 'proposal')),
  -- The assistant row this post shows or belongs to; set null when P5b's retention deletes it (the ts stays for the DM purge).
  message_id      text references public.exec_messages(id) on delete set null,
  -- The draft (ed_…) or proposal (etp_…) a card shows. No FK: the card outlives its row.
  ref_id          text constraint exec_slack_posts_ref_shape_check check (ref_id is null or ref_id ~ '^(ed|etp)_[0-9a-f]{32}$'),
  posted_at       timestamptz not null default now(),
  -- C42: the redaction / purge timestamp this post was last re-rendered for; null = never.
  followed_at     timestamptz,
  constraint exec_slack_posts_pkey primary key (installation_id, ts),
  constraint exec_slack_posts_ref_check check ((kind in ('draft', 'proposal')) = (ref_id is not null)),
  constraint exec_slack_posts_ref_kind_check
    check (ref_id is null or (kind = 'draft') = (left(ref_id, 3) = 'ed_'))
);
create index if not exists exec_slack_posts_posted_idx on public.exec_slack_posts (installation_id, posted_at);
create index if not exists exec_slack_posts_message_idx on public.exec_slack_posts (message_id) where message_id is not null;
create index if not exists exec_slack_posts_ref_idx on public.exec_slack_posts (ref_id) where ref_id is not null;
create index if not exists exec_slack_posts_answer_idx on public.exec_slack_posts (principal_id) where kind = 'answer';

-- ---------------------------------------------------------------------------
-- exec_access_log + slack_user_id, slack_event_id (K9; surface 'slack' rows only)
-- ---------------------------------------------------------------------------
-- Added NOT VALID, then validated: every existing row has both null, so the validation passes and
-- the grid can require convalidated.

alter table public.exec_access_log add column if not exists slack_user_id  text;
alter table public.exec_access_log add column if not exists slack_event_id text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exec_access_log_slack_user_check') then
    alter table public.exec_access_log add constraint exec_access_log_slack_user_check
      check (slack_user_id is null or slack_user_id ~ '^[UW][A-Z0-9]{2,30}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_access_log_slack_event_check') then
    alter table public.exec_access_log add constraint exec_access_log_slack_event_check
      check (slack_event_id is null or slack_event_id ~ '^Ev[A-Za-z0-9]{2,40}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_access_log_slack_surface_check') then
    alter table public.exec_access_log add constraint exec_access_log_slack_surface_check
      check (surface = 'slack' or (slack_user_id is null and slack_event_id is null)) not valid;
  end if;
end $$;
alter table public.exec_access_log validate constraint exec_access_log_slack_user_check;
alter table public.exec_access_log validate constraint exec_access_log_slack_event_check;
alter table public.exec_access_log validate constraint exec_access_log_slack_surface_check;

-- ---------------------------------------------------------------------------
-- RPC 3: exec_slack_revoke_installation (created before RPC 1, which calls it)
-- ---------------------------------------------------------------------------
-- Marks the active row revoked (once) and, while the row isn't purged, enqueues the bulk purge
-- job (dedupe per installation). The second call returns revoked = false and adds no job.

drop function if exists public.exec_slack_revoke_installation(text, text);
create or replace function public.exec_slack_revoke_installation(p_installation_id text, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revoked boolean;
begin
  if p_reason is null or p_reason not in ('app_uninstalled', 'tokens_revoked', 'disconnected') then
    raise exception 'exec_slack_revoke_installation: bad reason %', p_reason;
  end if;
  update public.exec_slack_installations
     set revoked_at = now(), revoke_reason = p_reason, updated_at = now()
   where id = p_installation_id and revoked_at is null;
  v_revoked := found;
  if exists (select 1 from public.exec_slack_installations
              where id = p_installation_id and revoked_at is not null and purged_at is null) then
    insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
    values ('exec.slack-uninstall', 'bulk', null,
            jsonb_build_object('installation_id', p_installation_id, 'mode', 'purge'),
            'slack-uninstall:' || p_installation_id, 6)
    on conflict (dedupe_key) do nothing;
  end if;
  return jsonb_build_object('revoked', v_revoked);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 1: exec_slack_accept_event (K7; the routing rule, section 2.4 of the contract)
-- ---------------------------------------------------------------------------
-- The route has already checked the signature, type = event_callback, the app and team ids and
-- EXEC_ENABLED. This function is the ONLY place the routing rule is evaluated (C4): the route
-- passes facts (booleans and ids, never text). Insert first: a conflict on event_id means the
-- event was already accepted and nothing else happens (a redelivery after the job row was purged
-- creates no second job). A null boolean fact fails closed.

drop function if exists public.exec_slack_accept_event(text, text, text, text, bigint, integer, text, text, text, text, text,
  boolean, boolean, text, boolean, boolean, boolean, text, text[], text[]);
create or replace function public.exec_slack_accept_event(
  p_event_id         text,     -- envelope event_id
  p_team_id          text,     -- envelope team_id
  p_api_app_id       text,     -- envelope api_app_id
  p_event_type       text,     -- event.type: message | app_home_opened | app_uninstalled | tokens_revoked | anything else
  p_event_time       bigint,   -- envelope event_time, epoch seconds
  p_retry_num        integer,  -- x-slack-retry-num, 0 when absent
  p_channel          text,     -- event.channel when a string, else null
  p_channel_type     text,     -- event.channel_type when a string, else null
  p_user             text,     -- event.user when a string, else null (never the nested message's user)
  p_ts               text,     -- event.ts
  p_thread_ts        text,     -- event.thread_ts
  p_has_bot_id       boolean,  -- event.bot_id or event.bot_profile present
  p_has_app_id       boolean,  -- event.app_id present
  p_subtype          text,     -- event.subtype when present (any value), else null
  p_hidden           boolean,  -- event.hidden === true
  p_text_is_string   boolean,  -- typeof event.text === "string"
  p_has_message      boolean,  -- a nested event.message or event.previous_message is present
  p_tab              text,     -- app_home_opened: event.tab
  p_revoked_bot_ids  text[],   -- tokens_revoked: event.tokens.bot (bot user ids)
  p_revoked_user_ids text[]    -- tokens_revoked: event.tokens.oauth (user ids)
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_ts       constant text := '^[0-9]{1,12}\.[0-9]{1,8}$';
  c_user     constant text := '^[UW][A-Z0-9]{2,30}$';
  v_now      timestamptz := now();
  v_time     timestamptz;
  v_inst     public.exec_slack_installations%rowtype;
  v_found    boolean := false;
  v_decision text := 'drop';
  v_reason   text := null;
  v_kind     text := null;
  v_attempts integer := null;
  v_dedupe   text := null;
  v_payload  jsonb := null;
  v_job      bigint := null;
  v_ids      text[] := null;
  v_id       text;
  v_inserted text;
begin
  if p_event_id is null or p_event_id !~ '^Ev[A-Za-z0-9]{2,40}$' then raise exception 'exec_slack_accept_event: bad event_id'; end if;
  if p_team_id is null or p_api_app_id is null or p_event_type is null then
    raise exception 'exec_slack_accept_event: team, app and type are required';
  end if;
  if p_event_time is null or p_event_time <= 0 or p_event_time > 4102444800 then
    raise exception 'exec_slack_accept_event: bad event_time';
  end if;
  v_time := to_timestamp(p_event_time);

  if p_event_type = 'message' then
    select * into v_inst from public.exec_slack_installations i
     where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id
       and i.slack_dm_channel_id = p_channel;
    v_found := found;
    if not v_found then
      v_reason := case when exists (select 1 from public.exec_slack_installations i
                                     where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id)
                       then 'other_channel' else 'not_installed' end;
    elsif p_channel_type is distinct from 'im'              then v_reason := 'not_im';
    elsif p_user is distinct from v_inst.user_id            then v_reason := 'other_user';
    elsif coalesce(p_has_bot_id, true)                      then v_reason := 'bot_message';
    elsif coalesce(p_has_app_id, true)                      then v_reason := 'app_message';
    elsif p_subtype is not null                             then v_reason := 'subtype';
    elsif coalesce(p_hidden, true)                          then v_reason := 'hidden';
    elsif not coalesce(p_text_is_string, false)             then v_reason := 'no_text';
    elsif coalesce(p_has_message, true)                     then v_reason := 'nested_message';
    elsif p_ts is null or p_ts !~ c_ts
       or (p_thread_ts is not null and p_thread_ts !~ c_ts) then v_reason := 'bad_ts';
    else
      v_decision := 'reply';
      v_kind     := 'exec.slack-reply';
      v_attempts := 1;
      v_dedupe   := 'slack-reply:' || p_event_id;
      v_payload  := jsonb_build_object('event_id', p_event_id, 'installation_id', v_inst.id, 'channel', p_channel,
                      'ts', p_ts, 'thread_ts', p_thread_ts, 'event_time', p_event_time);
    end if;

  elsif p_event_type = 'app_home_opened' then
    select * into v_inst from public.exec_slack_installations i
     where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id and i.user_id = p_user
     order by i.installed_at limit 1;
    v_found := found;
    if not v_found then
      select * into v_inst from public.exec_slack_installations i
       where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id
       order by i.installed_at limit 1;
      v_found := found;
    end if;
    if not v_found                                   then v_reason := 'not_installed';
    elsif p_user is null or p_user !~ c_user         then v_reason := 'bad_user';
    elsif p_tab is distinct from 'home'              then v_reason := 'messages_tab';
    else
      v_decision := 'home';
      v_kind     := 'exec.slack-home';
      v_attempts := 2;
      -- C29: one Home render per installation, user and minute.
      v_dedupe   := 'slack-home:' || v_inst.id || ':' || p_user || ':' || floor(extract(epoch from v_now) / 60)::bigint::text;
      v_payload  := jsonb_build_object('installation_id', v_inst.id, 'slack_user_id', p_user);
    end if;

  elsif p_event_type = 'app_uninstalled' then
    select array_agg(i.id order by i.installed_at) into v_ids from public.exec_slack_installations i
     where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id and i.installed_at <= v_time;
    if v_ids is null then
      v_reason := case when exists (select 1 from public.exec_slack_installations i
                                     where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id)
                       then 'stale_revoke' else 'not_installed' end;
    else
      v_decision := 'revoke';
    end if;

  elsif p_event_type = 'tokens_revoked' then
    if coalesce(cardinality(p_revoked_bot_ids), 0) = 0 then
      v_reason := case when coalesce(cardinality(p_revoked_user_ids), 0) > 0 then 'user_tokens_only' else 'empty_revoke' end;
    else
      select array_agg(i.id order by i.installed_at) into v_ids from public.exec_slack_installations i
       where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id
         and i.bot_user_id = any (p_revoked_bot_ids) and i.installed_at <= v_time;
      if v_ids is null then
        v_reason := case when exists (select 1 from public.exec_slack_installations i
                                       where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id
                                         and i.bot_user_id = any (p_revoked_bot_ids))
                         then 'stale_revoke' else 'not_installed' end;
      else
        v_decision := 'revoke_check';
      end if;
    end if;

  else
    v_reason := 'unsupported_type';
  end if;

  if v_decision in ('revoke', 'revoke_check') then
    select * into v_inst from public.exec_slack_installations where id = v_ids[1];
    v_found := found;
  end if;

  -- Insert first (K7): a conflict means this event_id was already accepted; nothing else happens.
  insert into public.exec_slack_events (event_id, installation_id, principal_id, team_id, api_app_id, event_type, decision,
                                        drop_reason, channel_id, message_ts, thread_ts, slack_user_id, event_time, retry_num,
                                        reply_state)
  values (p_event_id,
          case when v_found then v_inst.id end,
          case when v_found then v_inst.principal_id end,
          left(p_team_id, 40), left(p_api_app_id, 40),
          case when p_event_type ~ '^[a-z_.]{1,60}$' then p_event_type else 'unknown' end,
          v_decision, v_reason,
          case when v_decision = 'reply' then p_channel end,
          case when v_decision = 'reply' then p_ts end,
          case when v_decision = 'reply' then p_thread_ts end,
          -- C47 (security-11): only the owner's id is kept; colleagues' ids are never stored here.
          case when v_found and p_user ~ c_user and p_user = v_inst.user_id then p_user end,
          v_time, least(greatest(coalesce(p_retry_num, 0), 0), 100),
          case when v_decision = 'reply' then 'queued' end)
  on conflict (event_id) do nothing
  returning event_id into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if v_decision in ('reply', 'home') then
    insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
    values (v_kind, 'interactive', v_inst.principal_id, v_payload, v_dedupe, v_attempts)
    on conflict (dedupe_key) do nothing
    returning id into v_job;
    if v_job is not null then
      update public.exec_slack_events set job_id = v_job where event_id = p_event_id;
    end if;
  elsif v_decision = 'revoke' then
    foreach v_id in array v_ids loop
      perform public.exec_slack_revoke_installation(v_id, 'app_uninstalled');
    end loop;
  elsif v_decision = 'revoke_check' then
    foreach v_id in array v_ids loop
      insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
      values ('exec.slack-uninstall', 'bulk', null,
              jsonb_build_object('installation_id', v_id, 'mode', 'check', 'event_time', p_event_time),
              'slack-revoke-check:' || p_event_id || ':' || v_id, 3)
      on conflict (dedupe_key) do nothing;
    end loop;
  end if;

  return jsonb_build_object('outcome', 'accepted', 'decision', v_decision, 'reason', v_reason,
                            'enqueued', v_job is not null, 'interactive', v_job is not null);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 2: exec_slack_accept_action (K8, C13): the interactions ack
-- ---------------------------------------------------------------------------
-- The clicker must be the active installation's own user (team, app AND user), the container his
-- DM, the action one of ours and the value one of our own id.version strings. The trigger id is
-- used for the dedupe key only and is never stored anywhere else.

drop function if exists public.exec_slack_accept_action(text, text, text, text, text, text, text, text, text);
create or replace function public.exec_slack_accept_action(
  p_team_id        text,
  p_api_app_id     text,
  p_user_id        text,   -- payload.user.id
  p_trigger_id     text,   -- payload.trigger_id (dedupe only; never stored elsewhere)
  p_action_id      text,   -- payload.actions[0].action_id
  p_value          text,   -- payload.actions[0].value
  p_container_type text,   -- payload.container.type
  p_channel_id     text,   -- payload.container.channel_id
  p_message_ts     text    -- payload.container.message_ts
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inst public.exec_slack_installations%rowtype;
  v_job  bigint;
begin
  select * into v_inst from public.exec_slack_installations i
   where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id and i.user_id = p_user_id
   order by i.installed_at limit 1;
  if not found then return jsonb_build_object('outcome', 'ignored', 'reason', 'not_owner'); end if;
  if p_container_type is distinct from 'message' then return jsonb_build_object('outcome', 'ignored', 'reason', 'container'); end if;
  if p_channel_id is distinct from v_inst.slack_dm_channel_id then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'other_channel');
  end if;
  if p_message_ts is null or p_message_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$' then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'bad_ts');
  end if;
  if p_action_id is null or p_action_id not in ('ea_draft_save', 'ea_draft_regen', 'ea_card_refresh',
                                                'ea_task_create', 'ea_task_dismiss', 'ea_fb_up', 'ea_fb_down') then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'unknown_action');
  end if;
  if p_value is null or char_length(p_value) > 200 or p_value !~ '^[a-z][0-9]\.[A-Za-z0-9_.]+$' then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'bad_value');
  end if;
  if p_trigger_id is null or p_trigger_id !~ '^[A-Za-z0-9.]{1,200}$' then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'bad_trigger');
  end if;
  insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
  values ('exec.slack-action', 'interactive', v_inst.principal_id,
          jsonb_build_object('installation_id', v_inst.id, 'action_id', p_action_id, 'value', p_value,
                             'channel_id', p_channel_id, 'message_ts', p_message_ts),
          'slack-act:' || p_trigger_id, 1)
  on conflict (dedupe_key) do nothing
  returning id into v_job;
  return jsonb_build_object('outcome', case when v_job is null then 'duplicate' else 'enqueued' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 4: exec_slack_purge_installation (C18): after a revoke
-- ---------------------------------------------------------------------------
-- Nulls the token, deletes the installation's events and ledger rows, and deletes the
-- surface='slack' conversations of THAT installation (their messages, staged tasks and feedback
-- cascade). The row stays as the revoked record. A second run finds the same revoked row, deletes
-- nothing more and returns zeros; purged_at keeps its first value.

drop function if exists public.exec_slack_purge_installation(text);
create or replace function public.exec_slack_purge_installation(p_installation_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_principal     text;
  v_revoked_at    timestamptz;
  v_events        integer := 0;
  v_posts         integer := 0;
  v_conversations integer := 0;
begin
  select principal_id, revoked_at into v_principal, v_revoked_at
    from public.exec_slack_installations
   where id = p_installation_id and revoked_at is not null
   for update;
  if not found then return jsonb_build_object('purged', false); end if;
  delete from public.exec_slack_events where installation_id = p_installation_id;
  get diagnostics v_events = row_count;
  delete from public.exec_slack_posts where installation_id = p_installation_id;
  get diagnostics v_posts = row_count;
  update public.exec_slack_installations
     set bot_token_enc = null, key_id = null, purged_at = coalesce(purged_at, now()), updated_at = now()
   where id = p_installation_id;
  -- C18 (security-3): this installation's conversations, whatever other installations exist. Only one
  -- installation per principal is active at a time (exec_slack_installations_active_key), so every Slack
  -- conversation created up to this row's revoked_at belongs to it (or to an earlier, already purged one);
  -- a reconnect's conversations are newer and stay, even on the same D… channel. The bound is on time, not
  -- on the channel, so an in-place reinstall that moved the DM channel is still covered.
  delete from public.exec_conversations
   where principal_id = v_principal and surface = 'slack'
     and created_at <= v_revoked_at;
  get diagnostics v_conversations = row_count;
  return jsonb_build_object('purged', true, 'events', v_events, 'posts', v_posts, 'conversations', v_conversations);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 5: exec_slack_conversation_for_thread (C6): one conversation per DM thread
-- ---------------------------------------------------------------------------
-- P5b's begin RPC has no Slack parameters, so this get-or-creates the surface='slack'
-- conversation of (DM channel, root ts); the job then begins the turn with its id. ON CONFLICT DO
-- NOTHING without a target covers both of P5b's keys (exec_conversations_create_turn_key and the
-- partial exec_conversations_slack_thread_key), so two jobs racing on one thread get the same row.
-- A thread's conversation from before a revocation whose purge (RPC 4) hasn't run yet belongs to the
-- revoked installation, and RPC 4 deletes it (created_at <= revoked_at). A reconnect's turn in that old
-- thread therefore never joins it: the old conversation goes now (as the purge would) and the turn gets a
-- fresh one, which the purge keeps (C18: a reconnect neither saves the old conversations nor loses the
-- new ones).

drop function if exists public.exec_slack_conversation_for_thread(text, text, text, text, integer);
create or replace function public.exec_slack_conversation_for_thread(
  p_principal      text,
  p_channel        text,     -- the DM channel (D…)
  p_root_ts        text,     -- thread_ts ?? ts
  p_title          text,     -- newConversationTitle(first question)
  p_retention_days integer   -- exec_settings.retention_days_chat
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id      text;
  v_days    integer := least(greatest(coalesce(p_retention_days, 90), 1), 3650);
  v_pending timestamptz;
begin
  if p_channel is null or p_channel !~ '^D[A-Z0-9]{2,30}$' then raise exception 'exec_slack_conversation_for_thread: bad channel'; end if;
  if p_root_ts is null or p_root_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$' then raise exception 'exec_slack_conversation_for_thread: bad ts'; end if;
  -- The latest revocation still waiting for its purge (C18).
  select max(i.revoked_at) into v_pending
    from public.exec_slack_installations i
   where i.principal_id = p_principal and i.revoked_at is not null and i.purged_at is null;
  if v_pending is not null then
    delete from public.exec_conversations
     where principal_id = p_principal and surface = 'slack' and slack_channel_id = p_channel and slack_thread_ts = p_root_ts
       and created_at <= v_pending;
  end if;
  insert into public.exec_conversations (principal_id, surface, title, create_client_turn_id, slack_channel_id, slack_thread_ts, expires_at)
  values (p_principal, 'slack', left(coalesce(nullif(btrim(p_title), ''), 'Slack conversation'), 120),
          'slkc_' || p_channel || '_' || replace(p_root_ts, '.', '_'), p_channel, p_root_ts,
          now() + make_interval(days => v_days))
  on conflict do nothing;
  select id into v_id from public.exec_conversations
   where principal_id = p_principal and slack_channel_id = p_channel and slack_thread_ts = p_root_ts;
  if v_id is null then raise exception 'exec_slack_conversation_for_thread: no conversation after insert'; end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 6: exec_slack_reply_step (C8): CAS on a DM reply's state
-- ---------------------------------------------------------------------------
-- queued -> started -> placeholder -> answered | failed; queued/started -> skipped; any open
-- state -> swept. Each transition sets updated_at (the sweep's clock). A lost CAS returns false:
-- the caller then knows the sweep owns the reply.

drop function if exists public.exec_slack_reply_step(text, text[], text, text, text, text);
create or replace function public.exec_slack_reply_step(
  p_event_id             text,
  p_from                 text[],   -- allowed current states
  p_to                   text,     -- the new state
  p_placeholder_ts       text,     -- required when p_to = 'placeholder', else null
  p_conversation_id      text,     -- set with 'placeholder'
  p_assistant_message_id text      -- set with 'placeholder'
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_installation text;
  v_principal    text;
begin
  if p_to is null or p_to not in ('started', 'placeholder', 'answered', 'failed', 'skipped', 'swept') then
    raise exception 'exec_slack_reply_step: bad target %', p_to;
  end if;
  -- The only transitions (C8).
  if not ((p_to = 'started' and p_from <@ array['queued'])
       or (p_to = 'placeholder' and p_from <@ array['started'])
       or (p_to in ('answered', 'failed') and p_from <@ array['started', 'placeholder'])
       or (p_to = 'skipped' and p_from <@ array['queued', 'started'])
       or (p_to = 'swept' and p_from <@ array['queued', 'started', 'placeholder'])) then
    raise exception 'exec_slack_reply_step: transition not allowed';
  end if;
  if p_to = 'placeholder' and (p_placeholder_ts is null or p_placeholder_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$') then
    raise exception 'exec_slack_reply_step: placeholder ts required';
  end if;
  update public.exec_slack_events
     set reply_state          = p_to,
         placeholder_ts       = coalesce(p_placeholder_ts, placeholder_ts),
         conversation_id      = coalesce(p_conversation_id, conversation_id),
         assistant_message_id = coalesce(p_assistant_message_id, assistant_message_id),
         updated_at           = now()
   where event_id = p_event_id and decision = 'reply' and reply_state = any (p_from)
  returning installation_id, principal_id into v_installation, v_principal;
  if not found then return false; end if;
  if p_to = 'placeholder' and p_assistant_message_id is not null then
    -- K9: the placeholder ts lands on the answer row before the model call. 0 rows (already finished
    -- or swept by P5b) is fine: the event row still holds the ts for the sweep.
    update public.exec_messages set slack_ts = p_placeholder_ts, updated_at = now()
     where id = p_assistant_message_id and principal_id = v_principal and role = 'assistant' and slack_ts is null;
  end if;
  if p_to = 'placeholder' then
    -- C43: the answer post's ledger row lands with this transition. dmPost writes it first, best effort;
    -- if that write failed, this one keeps the answer reachable by RPC 7 (a) and the DM purge (a conflict
    -- with dmPost's row is a no-op).
    insert into public.exec_slack_posts (installation_id, principal_id, channel_id, ts, thread_ts, kind, message_id)
    select e.installation_id, e.principal_id, e.channel_id, p_placeholder_ts, coalesce(e.thread_ts, e.message_ts), 'answer',
           (select m.id from public.exec_messages m
             where m.id = p_assistant_message_id and m.principal_id = e.principal_id and m.role = 'assistant')
      from public.exec_slack_events e
     where e.event_id = p_event_id and e.installation_id is not null and e.principal_id is not null
       and e.channel_id is not null and e.message_ts is not null
    on conflict do nothing;
  end if;
  if p_to = 'answered' then
    update public.exec_slack_installations
       set last_dm_at = now(), last_error_code = null, last_error_at = null, updated_at = now()
     where id = v_installation;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC 7: exec_slack_redaction_followups (C42; K12)
-- ---------------------------------------------------------------------------
-- The caller re-renders each post and stores followed_at = changed_at (the value read here, never
-- now()), guarded by followed_at is null or followed_at < changed_at, so a redaction landing during
-- the follow is picked up next time. (a) re-renders an answer's cards with it; (c) also returns
-- proposal cards on their own (P5b redacts a proposal together with its message), because the reply
-- job posts its cards after the answered CAS, so a card can land after (a) followed its answer.

drop function if exists public.exec_slack_redaction_followups(text, text, integer);
create or replace function public.exec_slack_redaction_followups(p_principal text, p_installation_id text, p_limit integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit     integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_answers   jsonb;
  v_drafts    jsonb;
  v_proposals jsonb;
begin
  if p_principal is null or p_installation_id is null then
    raise exception 'exec_slack_redaction_followups: principal and installation are required';
  end if;
  -- (a) Answers P5b redacted (B7/C19–C21) after this post last showed them. exec_chat_redact_threads keeps
  -- the first redacted_at but sets updated_at on every change (an UNCHECKED_TEXT later replaced by
  -- REDACTED_TEXT), so updated_at is the change marker. Replies still open are excluded: the reply job's
  -- own answer update must land first (C42).
  select coalesce(jsonb_agg(jsonb_build_object('ts', s.ts, 'message_id', s.message_id,
                                               'conversation_id', s.conversation_id, 'changed_at', s.changed_at)
                            order by s.changed_at), '[]'::jsonb)
    into v_answers
    from (select p.ts, m.id as message_id, m.conversation_id, m.updated_at as changed_at
            from public.exec_slack_posts p
            join public.exec_messages m on m.id = p.message_id
           where p.principal_id = p_principal and p.installation_id = p_installation_id and p.kind = 'answer'
             and m.principal_id = p_principal and m.redacted_at is not null
             and (p.followed_at is null or m.updated_at > p.followed_at)
             and not exists (select 1 from public.exec_slack_events e
                              where e.assistant_message_id = m.id
                                and e.reply_state in ('queued', 'started', 'placeholder'))
           order by m.updated_at
           limit v_limit) s;
  -- (b) Draft cards whose draft P4's restricted purge (or P5b's purge by id) emptied after the card last
  -- showed it.
  select coalesce(jsonb_agg(jsonb_build_object('ts', s.ts, 'draft_id', s.ref_id, 'changed_at', s.changed_at)
                            order by s.changed_at), '[]'::jsonb)
    into v_drafts
    from (select p.ts, p.ref_id, d.updated_at as changed_at
            from public.exec_slack_posts p
            join public.exec_drafts d on d.id = p.ref_id
           where p.principal_id = p_principal and p.installation_id = p_installation_id and p.kind = 'draft'
             and d.principal_id = p_principal and d.restricted_purged
             and (p.followed_at is null or d.updated_at > p.followed_at)
           order by d.updated_at
           limit v_limit) s;
  -- (c) Proposal cards whose proposal P5b redacted (withdrawn, or redacted after a decision) after the card
  -- last showed it.
  select coalesce(jsonb_agg(jsonb_build_object('ts', s.ts, 'proposal_id', s.ref_id, 'changed_at', s.changed_at)
                            order by s.changed_at), '[]'::jsonb)
    into v_proposals
    from (select p.ts, p.ref_id, t.updated_at as changed_at
            from public.exec_slack_posts p
            join public.exec_task_proposals t on t.id = p.ref_id
           where p.principal_id = p_principal and p.installation_id = p_installation_id and p.kind = 'proposal'
             and t.principal_id = p_principal and t.redacted_at is not null
             and (p.followed_at is null or t.updated_at > p.followed_at)
           order by t.updated_at
           limit v_limit) s;
  return jsonb_build_object('answers', v_answers, 'drafts', v_drafts, 'proposals', v_proposals);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, no policies; service_role only
-- ---------------------------------------------------------------------------

alter table public.exec_slack_installations enable row level security;
alter table public.exec_slack_events        enable row level security;
alter table public.exec_oauth_states        enable row level security;
alter table public.exec_chat_feedback       enable row level security;
alter table public.exec_slack_posts         enable row level security;
revoke all on public.exec_slack_installations, public.exec_slack_events, public.exec_oauth_states, public.exec_chat_feedback,
  public.exec_slack_posts from public, anon, authenticated;
grant all on public.exec_slack_installations, public.exec_slack_events, public.exec_oauth_states, public.exec_chat_feedback,
  public.exec_slack_posts to service_role;
-- (exec_access_log keeps P2a's grants: the new columns inherit them.)
revoke all on function public.exec_slack_accept_event(text, text, text, text, bigint, integer, text, text, text, text, text,
  boolean, boolean, text, boolean, boolean, boolean, text, text[], text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_accept_action(text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_revoke_installation(text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_purge_installation(text) from public, anon, authenticated;
revoke all on function public.exec_slack_conversation_for_thread(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.exec_slack_reply_step(text, text[], text, text, text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_redaction_followups(text, text, integer) from public, anon, authenticated;
grant execute on function public.exec_slack_accept_event(text, text, text, text, bigint, integer, text, text, text, text, text,
  boolean, boolean, text, boolean, boolean, boolean, text, text[], text[]) to service_role;
grant execute on function public.exec_slack_accept_action(text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.exec_slack_revoke_installation(text, text) to service_role;
grant execute on function public.exec_slack_purge_installation(text) to service_role;
grant execute on function public.exec_slack_conversation_for_thread(text, text, text, text, integer) to service_role;
grant execute on function public.exec_slack_reply_step(text, text[], text, text, text, text) to service_role;
grant execute on function public.exec_slack_redaction_followups(text, text, integer) to service_role;

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
--   * every column of the five new tables, with type and nullability, and the
--     column defaults the app relies on;
--   * every named CHECK (a few by the words their definition must hold);
--     the three exec_access_log CHECKs exist AND are validated, and its two
--     new columns are nullable text;
--   * the five primary keys by columns, and the eleven foreign keys with their
--     ON DELETE action, by columns and target;
--   * every index by its definition (the text after " USING ") and uniqueness;
--   * the seven functions: SECURITY INVOKER with search_path pinned to '', and
--     one signature each;
--   * what this file relies on from P5b and P4: exec_conversations_create_turn_key,
--     exec_conversations_slack_thread_key, exec_messages_slack_ts_key,
--     exec_messages.redacted_at and exec_drafts.restricted_purged.
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
  select 'columns: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_slack_installations'), ('exec_slack_events'), ('exec_oauth_states'), ('exec_chat_feedback'),
               ('exec_slack_posts')) e(tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_slack_installations', 1, 'id', 'text', true),
      ('exec_slack_installations', 2, 'principal_id', 'text', true),
      ('exec_slack_installations', 3, 'team_id', 'text', true),
      ('exec_slack_installations', 4, 'app_id', 'text', true),
      ('exec_slack_installations', 5, 'bot_user_id', 'text', true),
      ('exec_slack_installations', 6, 'bot_id', 'text', true),
      ('exec_slack_installations', 7, 'bot_token_enc', 'text', false),
      ('exec_slack_installations', 8, 'key_id', 'text', false),
      ('exec_slack_installations', 9, 'bot_scopes', 'text[]', true),
      ('exec_slack_installations', 10, 'user_id', 'text', true),
      ('exec_slack_installations', 11, 'user_token_enc', 'text', false),
      ('exec_slack_installations', 12, 'user_scopes', 'text[]', true),
      ('exec_slack_installations', 13, 'slack_dm_channel_id', 'text', true),
      ('exec_slack_installations', 14, 'installed_at', 'timestamp with time zone', true),
      ('exec_slack_installations', 15, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_installations', 16, 'revoked_at', 'timestamp with time zone', false),
      ('exec_slack_installations', 17, 'revoke_reason', 'text', false),
      ('exec_slack_installations', 18, 'last_dm_at', 'timestamp with time zone', false),
      ('exec_slack_installations', 19, 'last_error_code', 'text', false),
      ('exec_slack_installations', 20, 'last_error_at', 'timestamp with time zone', false),
      ('exec_slack_installations', 21, 'purged_at', 'timestamp with time zone', false),
      ('exec_slack_events', 1, 'event_id', 'text', true),
      ('exec_slack_events', 2, 'installation_id', 'text', false),
      ('exec_slack_events', 3, 'principal_id', 'text', false),
      ('exec_slack_events', 4, 'team_id', 'text', true),
      ('exec_slack_events', 5, 'api_app_id', 'text', true),
      ('exec_slack_events', 6, 'event_type', 'text', true),
      ('exec_slack_events', 7, 'decision', 'text', true),
      ('exec_slack_events', 8, 'drop_reason', 'text', false),
      ('exec_slack_events', 9, 'channel_id', 'text', false),
      ('exec_slack_events', 10, 'message_ts', 'text', false),
      ('exec_slack_events', 11, 'thread_ts', 'text', false),
      ('exec_slack_events', 12, 'slack_user_id', 'text', false),
      ('exec_slack_events', 13, 'event_time', 'timestamp with time zone', true),
      ('exec_slack_events', 14, 'retry_num', 'smallint', true),
      ('exec_slack_events', 15, 'job_id', 'bigint', false),
      ('exec_slack_events', 16, 'reply_state', 'text', false),
      ('exec_slack_events', 17, 'placeholder_ts', 'text', false),
      ('exec_slack_events', 18, 'conversation_id', 'text', false),
      ('exec_slack_events', 19, 'assistant_message_id', 'text', false),
      ('exec_slack_events', 20, 'received_at', 'timestamp with time zone', true),
      ('exec_slack_events', 21, 'updated_at', 'timestamp with time zone', true),
      ('exec_oauth_states', 1, 'nonce_hash', 'text', true),
      ('exec_oauth_states', 2, 'provider', 'text', true),
      ('exec_oauth_states', 3, 'principal_id', 'text', true),
      ('exec_oauth_states', 4, 'auth_user_id', 'text', true),
      ('exec_oauth_states', 5, 'session_id', 'text', true),
      ('exec_oauth_states', 6, 'created_at', 'timestamp with time zone', true),
      ('exec_oauth_states', 7, 'expires_at', 'timestamp with time zone', true),
      ('exec_chat_feedback', 1, 'principal_id', 'text', true),
      ('exec_chat_feedback', 2, 'message_id', 'text', true),
      ('exec_chat_feedback', 3, 'vote', 'smallint', true),
      ('exec_chat_feedback', 4, 'surface', 'text', true),
      ('exec_chat_feedback', 5, 'created_at', 'timestamp with time zone', true),
      ('exec_chat_feedback', 6, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_posts', 1, 'installation_id', 'text', true),
      ('exec_slack_posts', 2, 'principal_id', 'text', true),
      ('exec_slack_posts', 3, 'channel_id', 'text', true),
      ('exec_slack_posts', 4, 'ts', 'text', true),
      ('exec_slack_posts', 5, 'thread_ts', 'text', false),
      ('exec_slack_posts', 6, 'kind', 'text', true),
      ('exec_slack_posts', 7, 'message_id', 'text', false),
      ('exec_slack_posts', 8, 'ref_id', 'text', false),
      ('exec_slack_posts', 9, 'posted_at', 'timestamp with time zone', true),
      ('exec_slack_posts', 10, 'followed_at', 'timestamp with time zone', false)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select 'defaults: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_slack_installations'), ('exec_slack_events'), ('exec_oauth_states'), ('exec_chat_feedback'),
               ('exec_slack_posts')) e(tbl)
  cross join lateral (
    select string_agg(k.col || ' default ' || k.def, ', ' order by k.col) as wrong
    from (values
      ('exec_slack_installations', 'id', '(''esi_''::text || replace((gen_random_uuid())::text, ''-''::text, ''''::text))'),
      ('exec_slack_installations', 'bot_scopes', '''{}''::text[]'),
      ('exec_slack_installations', 'user_scopes', '''{}''::text[]'),
      ('exec_slack_installations', 'installed_at', 'now()'),
      ('exec_slack_installations', 'updated_at', 'now()'),
      ('exec_slack_events', 'retry_num', '0'),
      ('exec_slack_events', 'received_at', 'now()'),
      ('exec_slack_events', 'updated_at', 'now()'),
      ('exec_oauth_states', 'created_at', 'now()'),
      ('exec_chat_feedback', 'created_at', 'now()'),
      ('exec_chat_feedback', 'updated_at', 'now()'),
      ('exec_slack_posts', 'posted_at', 'now()')
    ) k(tbl, col, def)
    where k.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = k.col and not a.attisdropped
          and pg_get_expr(d.adbin, d.adrelid) = k.def)
  ) x
  union all
  select 'checks: ' || e.tbl, x.missing is null, x.missing
  from (values ('exec_slack_installations'), ('exec_slack_events'), ('exec_oauth_states'), ('exec_chat_feedback'),
               ('exec_slack_posts')) e(tbl)
  cross join lateral (
    select string_agg(k.name || case when d.def is null then '' else ' (definition)' end, ', ' order by k.name) as missing
    from (values
      ('exec_slack_installations_team_check', null), ('exec_slack_installations_app_check', null),
      ('exec_slack_installations_bot_user_check', null), ('exec_slack_installations_bot_id_check', null),
      ('exec_slack_installations_token_shape_check', array['bot_token_enc', 'v1']),
      ('exec_slack_installations_key_id_check', null), ('exec_slack_installations_bot_scopes_check', array['50']),
      ('exec_slack_installations_user_check', null),
      ('exec_slack_installations_no_user_token', array['user_token_enc', 'NULL']),
      ('exec_slack_installations_no_user_scopes', array['cardinality', 'user_scopes', '0']),
      ('exec_slack_installations_dm_check', array['slack_dm_channel_id']),
      ('exec_slack_installations_reason_check', array['app_uninstalled', 'tokens_revoked', 'disconnected']),
      ('exec_slack_installations_error_code_check', null),
      ('exec_slack_installations_active_token_check', array['revoked_at', 'bot_token_enc', 'key_id']),
      ('exec_slack_installations_revoke_pair_check', array['revoked_at', 'revoke_reason']),
      ('exec_slack_installations_error_pair_check', array['last_error_code', 'last_error_at']),
      ('exec_slack_installations_purged_check', array['purged_at', 'revoked_at', 'bot_token_enc', 'key_id']),
      ('exec_slack_events_id_check', null), ('exec_slack_events_team_check', null), ('exec_slack_events_app_check', null),
      ('exec_slack_events_type_check', null),
      ('exec_slack_events_decision_check', array['reply', 'home', 'revoke', 'revoke_check', 'drop']),
      ('exec_slack_events_reason_check', null), ('exec_slack_events_channel_check', array['channel_id']),
      ('exec_slack_events_ts_check', null), ('exec_slack_events_thread_check', null),
      ('exec_slack_events_user_check', array['slack_user_id']), ('exec_slack_events_retry_check', null),
      ('exec_slack_events_state_check', array['queued', 'started', 'placeholder', 'answered', 'failed', 'skipped', 'swept']),
      ('exec_slack_events_placeholder_check', null),
      ('exec_slack_events_reply_state_check', array['decision', 'reply_state']),
      ('exec_slack_events_drop_check', array['decision', 'drop_reason']),
      ('exec_slack_events_reply_refs_check', array['channel_id', 'message_ts', 'principal_id', 'installation_id']),
      ('exec_slack_events_placeholder_state_check', array['placeholder_ts', 'reply_state']),
      ('exec_oauth_states_hash_check', array['nonce_hash']), ('exec_oauth_states_provider_check', array['slack']),
      ('exec_oauth_states_auth_user_check', null), ('exec_oauth_states_session_check', null),
      ('exec_oauth_states_ttl_check', array['expires_at', 'created_at', '00:10:00']),
      ('exec_chat_feedback_vote_check', array['vote']), ('exec_chat_feedback_surface_check', array['web', 'slack']),
      ('exec_slack_posts_channel_check', null), ('exec_slack_posts_ts_check', null), ('exec_slack_posts_thread_check', null),
      ('exec_slack_posts_kind_check', array['answer', 'note', 'draft', 'proposal']),
      ('exec_slack_posts_ref_shape_check', array['ref_id']),
      ('exec_slack_posts_ref_check', array['kind', 'ref_id']),
      ('exec_slack_posts_ref_kind_check', array['ref_id', 'kind'])
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
  select 'check validated: ' || e.name, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_access_log_slack_user_check', array['slack_user_id']),
    ('exec_access_log_slack_event_check', array['slack_event_id']),
    ('exec_access_log_slack_surface_check', array['surface', 'slack', 'slack_user_id', 'slack_event_id'])
  ) e(name, needs)
  left join lateral (
    select pc.convalidated and not exists (select 1 from unnest(e.needs) w where pg_get_constraintdef(pc.oid) !~ ('\m' || w || '\M')) as ok,
           case when pc.convalidated then '' else 'NOT VALID: ' end || pg_get_constraintdef(pc.oid) as found
    from pg_constraint pc
    where pc.conrelid = to_regclass('public.exec_access_log') and pc.contype = 'c' and pc.conname = e.name
  ) x on true
  union all
  select 'column: exec_access_log.' || e.col || ' text (nullable)', coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values ('slack_user_id'), ('slack_event_id')) e(col)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = 'text' and not a.attnotnull as ok,
           format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end as found
    from pg_attribute a
    where a.attrelid = to_regclass('public.exec_access_log') and a.attname = e.col and not a.attisdropped
  ) x on true
  union all
  select e.label, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('primary key: exec_slack_installations', 'exec_slack_installations', 'exec_slack_installations_pkey', array['id']),
    ('primary key: exec_slack_events', 'exec_slack_events', 'exec_slack_events_pkey', array['event_id']),
    ('primary key: exec_oauth_states', 'exec_oauth_states', 'exec_oauth_states_pkey', array['nonce_hash']),
    ('primary key: exec_chat_feedback', 'exec_chat_feedback', 'exec_chat_feedback_pkey', array['principal_id', 'message_id']),
    ('primary key: exec_slack_posts', 'exec_slack_posts', 'exec_slack_posts_pkey', array['installation_id', 'ts'])
  ) e(label, tbl, name, cols)
  left join lateral (
    select k.contype = 'p' and c.cols = e.cols as ok,
           k.contype::text || ' (' || array_to_string(c.cols, ', ') || ')' as found
    from pg_constraint k
    cross join lateral (
      select array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                   order by u.ord) as cols) c
    where k.conrelid = to_regclass('public.' || e.tbl) and k.conname = e.name
  ) x on true
  union all
  select 'FK on delete ' || e.action || ': ' || e.tbl || ' (' || array_to_string(e.cols, ', ') || ') -> ' || e.ref,
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'f'
                   and k.confrelid = to_regclass('public.' || e.ref)
                   and k.confdeltype = case e.action when 'cascade' then 'c' when 'set null' then 'n' end
                   and array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                             order by u.ord) = e.cols),
         null
  from (values
    ('exec_slack_installations', array['principal_id'], 'exec_principals', 'cascade'),
    ('exec_slack_events', array['installation_id'], 'exec_slack_installations', 'set null'),
    ('exec_slack_events', array['principal_id'], 'exec_principals', 'cascade'),
    ('exec_slack_events', array['conversation_id'], 'exec_conversations', 'set null'),
    ('exec_slack_events', array['assistant_message_id'], 'exec_messages', 'set null'),
    ('exec_oauth_states', array['principal_id'], 'exec_principals', 'cascade'),
    ('exec_chat_feedback', array['principal_id'], 'exec_principals', 'cascade'),
    ('exec_chat_feedback', array['message_id'], 'exec_messages', 'cascade'),
    ('exec_slack_posts', array['installation_id'], 'exec_slack_installations', 'cascade'),
    ('exec_slack_posts', array['principal_id'], 'exec_principals', 'cascade'),
    ('exec_slack_posts', array['message_id'], 'exec_messages', 'set null')
  ) e(tbl, cols, ref, action)
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def and x.uniq = e.uniq, false),
         case when not coalesce(x.def = e.def and x.uniq = e.uniq, false)
              then coalesce(case when x.uniq then 'unique ' else '' end || x.def, '(missing)') end
  from (values
    ('exec_slack_installations', 'exec_slack_installations_active_key', 'btree (principal_id) WHERE (revoked_at IS NULL)', true),
    ('exec_slack_installations', 'exec_slack_installations_dm_key', 'btree (slack_dm_channel_id) WHERE (revoked_at IS NULL)', true),
    ('exec_slack_installations', 'exec_slack_installations_team_idx', 'btree (team_id, app_id) WHERE (revoked_at IS NULL)', false),
    ('exec_slack_installations', 'exec_slack_installations_principal_idx', 'btree (principal_id, installed_at DESC)', false),
    ('exec_slack_events', 'exec_slack_events_received_idx', 'btree (received_at)', false),
    ('exec_slack_events', 'exec_slack_events_open_idx',
     'btree (principal_id, updated_at) WHERE (reply_state = ANY (ARRAY[''queued''::text, ''started''::text, ''placeholder''::text]))', false),
    ('exec_slack_events', 'exec_slack_events_installation_idx', 'btree (installation_id, received_at DESC)', false),
    ('exec_slack_events', 'exec_slack_events_message_idx', 'btree (assistant_message_id) WHERE (assistant_message_id IS NOT NULL)', false),
    ('exec_oauth_states', 'exec_oauth_states_expires_idx', 'btree (expires_at)', false),
    ('exec_oauth_states', 'exec_oauth_states_principal_idx', 'btree (principal_id, provider)', false),
    ('exec_slack_posts', 'exec_slack_posts_posted_idx', 'btree (installation_id, posted_at)', false),
    ('exec_slack_posts', 'exec_slack_posts_message_idx', 'btree (message_id) WHERE (message_id IS NOT NULL)', false),
    ('exec_slack_posts', 'exec_slack_posts_ref_idx', 'btree (ref_id) WHERE (ref_id IS NOT NULL)', false),
    ('exec_slack_posts', 'exec_slack_posts_answer_idx', 'btree (principal_id) WHERE (kind = ''answer''::text)', false)
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
    ('exec_slack_accept_event(text,text,text,text,bigint,integer,text,text,text,text,text,boolean,boolean,text,boolean,boolean,boolean,text,text[],text[])'),
    ('exec_slack_accept_action(text,text,text,text,text,text,text,text,text)'),
    ('exec_slack_revoke_installation(text,text)'),
    ('exec_slack_purge_installation(text)'),
    ('exec_slack_conversation_for_thread(text,text,text,text,integer)'),
    ('exec_slack_reply_step(text,text[],text,text,text,text)'),
    ('exec_slack_redaction_followups(text,text,integer)')
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
  from (values ('exec_slack_accept_event'), ('exec_slack_accept_action'), ('exec_slack_revoke_installation'),
               ('exec_slack_purge_installation'), ('exec_slack_conversation_for_thread'), ('exec_slack_reply_step'),
               ('exec_slack_redaction_followups')) e(name)
  cross join lateral (
    select count(*)::int as n, string_agg(p.oid::regprocedure::text, '; ') as sigs
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = e.name
  ) x
  union all
  select 'relies on (P5b): ' || e.label, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('unique exec_conversations_create_turn_key (principal_id, create_client_turn_id)', 'exec_conversations', 'exec_conversations_create_turn_key',
     'UNIQUE (principal_id, create_client_turn_id)'),
    ('unique index exec_conversations_slack_thread_key', 'exec_conversations', 'exec_conversations_slack_thread_key',
     'unique btree (principal_id, slack_channel_id, slack_thread_ts) WHERE (slack_thread_ts IS NOT NULL)'),
    ('unique index exec_messages_slack_ts_key', 'exec_messages', 'exec_messages_slack_ts_key',
     'unique btree (principal_id, slack_ts) WHERE (slack_ts IS NOT NULL)')
  ) e(label, tbl, name, want)
  left join lateral (
    select coalesce(
             (select pg_get_constraintdef(k.oid) from pg_constraint k
               where k.conrelid = to_regclass('public.' || e.tbl) and k.conname = e.name and k.contype = 'u'),
             (select case when i.indisunique then 'unique ' else '' end
                     || substr(pg_get_indexdef(i.indexrelid), strpos(pg_get_indexdef(i.indexrelid), ' USING ') + 7)
                from pg_index i join pg_class ic on ic.oid = i.indexrelid
               where i.indrelid = to_regclass('public.' || e.tbl) and ic.relname = e.name)) as found
  ) f on true
  cross join lateral (select f.found = e.want as ok, f.found) x
  union all
  select 'relies on (' || e.phase || '): ' || e.tbl || '.' || e.col || ' ' || e.typ, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('P5b', 'exec_messages', 'redacted_at', 'timestamp with time zone'),
    ('P5b', 'exec_messages', 'updated_at', 'timestamp with time zone'),
    ('P4', 'exec_drafts', 'restricted_purged', 'boolean'),
    ('P4', 'exec_drafts', 'updated_at', 'timestamp with time zone')
  ) e(phase, tbl, col, typ)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = e.typ as ok, format_type(a.atttypid, a.atttypmod) as found
    from pg_attribute a
    where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = e.col and not a.attisdropped
  ) x on true
) checks
order by ok, check_name;
