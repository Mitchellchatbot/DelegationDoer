-- Executive AI Assistant — P7a Slack reading (re-consent, discovery, never-watch, events and sweeps,
-- storage, triage, purges, the Slack attention producer).
--
--   exec_settings              + slack_reading_enabled (default false; N20) and slack_daily_cap_usd (default 2; N8).
--                              watch_mode's default becomes 'member_only' (N12); the stored P2a default is flipped
--                              once, in the transaction that adds slack_reading_enabled. muted_channel_ids stays
--                              unused (N7: exec_slack_channels.watch_state is the one mute store).
--   exec_slack_installations   + the user (reading) half: user_key_id, user_installed_at, user_revoked_at,
--                              user_revoke_reason, user_last_error_*, reading_state, discovered_at,
--                              reading_purged_at. P6's two bot-only CHECKs keep their NAMES with relaxed bodies.
--   exec_slack_events          + ingest_outcome; decision also 'ingest' | 'lifecycle'.
--   exec_oauth_states          + purpose ('install' | 'read').
--   exec_slack_channels        one row per conversation: class, finance_name, watch_state, watermarks. A 'deny' row
--                              is a bare marker (N1): id, type, class, reason, nothing else.
--   exec_slack_threads         his participation and the per-thread reply watermark (no text).
--   exec_slack_messages        rows ONLY for candidates, items and DD anchors (no text; dd_paths = DD link paths).
--   exec_slack_items           the triage verdicts; the ONLY home of Slack text (excerpt <= 280, summary <= 200).
--                              source_class is derived here, in SQL, from the channel row (C45).
--   exec_slack_deleted         deleted markers (>= 25 h) so a deleted message is never written again.
--   exec_slack_rate            the per-method, per-minute Slack call budget with priority classes (N6).
--   exec_slack_dd_bot          the DD bot's own ids (N3), cached from auth.test.
--   exec_slack_purge_log       refs of every purge, 7 days, for P7b/P8 follow-ups.
--   exec_slack_author_optouts  Slack authors whose messages were deleted on request and are never ingested again (C44).
--
-- RPCs (SECURITY INVOKER, search_path pinned, EXECUTE for service_role only): the twenty-five functions locked down
-- at the end of this file.
--   exec_slack_accept_event_v2 is the reading ack gate; it calls P6's exec_slack_accept_event (unchanged) for
--   every P6 event. P6 code keeps working when this file is not applied (the route falls back to v1).
--
-- Security: RLS ON with NO policies; nothing granted to anon/authenticated.
-- Idempotent. Apply MANUALLY in the Supabase SQL editor AFTER 20261108100000_exec_slack.sql.
-- Nothing reads Slack until Mitchell gives the read consent in Settings AND the owner turns
-- slack_reading_enabled on after the PR's legal/notice checklist.

set local lock_timeout = '5s';

-- Pre-flight: P6 (its three tables and the exact v1 ack signature), P2a/P2b. Aborts before changing anything.
do $$
begin
  if to_regclass('public.exec_slack_installations') is null or to_regclass('public.exec_slack_events') is null
     or to_regclass('public.exec_oauth_states') is null then
    raise exception 'exec slack reading aborted, nothing changed: P6 is missing (apply 20261108100000_exec_slack.sql first)';
  end if;
  if to_regprocedure('public.exec_slack_accept_event(text, text, text, text, bigint, integer, text, text, text, text, text, '
                     || 'boolean, boolean, text, boolean, boolean, boolean, text, text[], text[])') is null then
    raise exception 'exec slack reading aborted, nothing changed: P6''s exec_slack_accept_event is missing or has another signature';
  end if;
  if to_regclass('public.exec_attention_items') is null or to_regclass('public.exec_settings') is null then
    raise exception 'exec slack reading aborted, nothing changed: the P2a/P2b tables are missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'exec_slack_installations' and column_name = 'user_token_enc') then
    raise exception 'exec slack reading aborted, nothing changed: exec_slack_installations.user_token_enc is missing (P6 incomplete)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- exec_settings (N8, N12, N20)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'exec_settings' and column_name = 'slack_reading_enabled') then
    alter table public.exec_settings add column slack_reading_enabled boolean not null default false;
    -- N12: member-only is the default. No P2a-P6 code path writes watch_mode (no settings field covers it), so every
    -- stored value is P2a's default. This runs once: only in the transaction that adds slack_reading_enabled, so a
    -- later owner opt-in is never undone by a re-run.
    update public.exec_settings set watch_mode = 'member_only', updated_at = now() where watch_mode = 'active_public';
  end if;
end $$;
alter table public.exec_settings alter column watch_mode set default 'member_only';
alter table public.exec_settings add column if not exists slack_daily_cap_usd numeric(10, 2) not null default 2;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exec_settings_slack_cap_check') then
    alter table public.exec_settings add constraint exec_settings_slack_cap_check
      check (slack_daily_cap_usd >= 0 and slack_daily_cap_usd <= 100);
  end if;
end $$;
comment on column public.exec_settings.muted_channel_ids is
  'Unused (P7a N7): exec_slack_channels.watch_state is the one mute store.';

-- ---------------------------------------------------------------------------
-- exec_slack_installations: the user half (N4)
-- ---------------------------------------------------------------------------

-- P6 pinned the bot-only install with two CHECKs and said P7 relaxes them. Their NAMES are kept (P6's grid checks
-- constraints by name, and by the words of their definitions: cardinality, user_scopes, 0 / user_token_enc, NULL);
-- the bodies now admit a sealed user token and the nine P7-1 scopes.
alter table public.exec_slack_installations drop constraint if exists exec_slack_installations_no_user_token;
alter table public.exec_slack_installations add constraint exec_slack_installations_no_user_token
  check (user_token_enc is null
         or user_token_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
alter table public.exec_slack_installations drop constraint if exists exec_slack_installations_no_user_scopes;
alter table public.exec_slack_installations add constraint exec_slack_installations_no_user_scopes
  check (cardinality(user_scopes) between 0 and 9
         and user_scopes <@ array['channels:history', 'groups:history', 'channels:read', 'groups:read', 'users:read',
                                  'im:history', 'im:read', 'mpim:history', 'mpim:read']::text[]);

alter table public.exec_slack_installations add column if not exists user_key_id          text;
alter table public.exec_slack_installations add column if not exists user_installed_at    timestamptz;
alter table public.exec_slack_installations add column if not exists user_revoked_at      timestamptz;
alter table public.exec_slack_installations add column if not exists user_revoke_reason   text;
alter table public.exec_slack_installations add column if not exists user_last_error_code text;
alter table public.exec_slack_installations add column if not exists user_last_error_at   timestamptz;
alter table public.exec_slack_installations add column if not exists reading_state        text not null default 'none';
alter table public.exec_slack_installations add column if not exists discovered_at        timestamptz;
alter table public.exec_slack_installations add column if not exists reading_purged_at    timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_installations_user_key_check') then
    alter table public.exec_slack_installations add constraint exec_slack_installations_user_key_check
      check (user_key_id is null or user_key_id ~ '^[0-9a-f]{8}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_installations_user_pair_check') then
    alter table public.exec_slack_installations add constraint exec_slack_installations_user_pair_check
      check ((user_token_enc is null) = (user_key_id is null));
  end if;
  -- A live user token has a consent time, no revocation and at least the required scopes recorded.
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_installations_user_live_check') then
    alter table public.exec_slack_installations add constraint exec_slack_installations_user_live_check
      check (user_token_enc is null
             or (user_installed_at is not null and user_revoked_at is null
                 and user_scopes @> array['channels:history', 'groups:history', 'channels:read', 'groups:read', 'users:read']::text[]));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_installations_user_revoke_check') then
    alter table public.exec_slack_installations add constraint exec_slack_installations_user_revoke_check
      check ((user_revoked_at is null) = (user_revoke_reason is null)
             and (user_revoke_reason is null
                  or user_revoke_reason in ('stopped', 'tokens_revoked', 'disconnected', 'app_uninstalled', 'installation_revoked')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_installations_user_error_check') then
    alter table public.exec_slack_installations add constraint exec_slack_installations_user_error_check
      check ((user_last_error_code is null) = (user_last_error_at is null)
             and (user_last_error_code is null or user_last_error_code ~ '^[a-z_]{1,60}$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_installations_reading_state_check') then
    alter table public.exec_slack_installations add constraint exec_slack_installations_reading_state_check
      check (reading_state in ('none', 'discovering', 'ready', 'revoked')
             and (reading_state in ('discovering', 'ready')) = (user_token_enc is not null)
             and (discovered_at is null or reading_state in ('ready', 'discovering')));
  end if;
end $$;

-- C7: one live reading half per workspace and app.
create unique index if not exists exec_slack_installations_reading_key
  on public.exec_slack_installations (team_id, app_id) where revoked_at is null and user_token_enc is not null;
create index if not exists exec_slack_installations_revoked_reading_idx
  on public.exec_slack_installations (id) where reading_state = 'revoked' and reading_purged_at is null;

-- ---------------------------------------------------------------------------
-- exec_slack_events: reading decisions (C6)
-- ---------------------------------------------------------------------------

alter table public.exec_slack_events add column if not exists ingest_outcome text;
-- Same name as P6's (its grid checks the name and the words reply, home, revoke, revoke_check, drop): the set grows
-- by the two reading decisions.
alter table public.exec_slack_events drop constraint if exists exec_slack_events_decision_check;
alter table public.exec_slack_events add constraint exec_slack_events_decision_check
  check (decision in ('reply', 'home', 'revoke', 'revoke_check', 'drop', 'ingest', 'lifecycle'));
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_events_ingest_check') then
    alter table public.exec_slack_events add constraint exec_slack_events_ingest_check
      check ((decision in ('ingest', 'lifecycle')) = (ingest_outcome is not null)
             and (ingest_outcome is null or ingest_outcome ~ '^[a-z_]{1,40}$')
             -- C6 / P6 C47: a reading row carries no channel, ts or thread, and no colleague's id.
             and (decision not in ('ingest', 'lifecycle')
                  or (channel_id is null and message_ts is null and thread_ts is null and reply_state is null)));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- exec_oauth_states: purpose (N4)
-- ---------------------------------------------------------------------------

alter table public.exec_oauth_states add column if not exists purpose text not null default 'install';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exec_oauth_states_purpose_check') then
    alter table public.exec_oauth_states add constraint exec_oauth_states_purpose_check check (purpose in ('install', 'read'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- exec_slack_dd_paths_ok (C46). Created BEFORE exec_slack_messages: its dd_paths CHECK calls it. Never dropped by a
-- re-run (the CHECK depends on it): create or replace with the same signature and return type only.
-- ---------------------------------------------------------------------------

create or replace function public.exec_slack_dd_paths_ok(p text[])
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  -- C46: <= 20 DD-relative paths, each <= 400 characters and matching DD_PATH_RE (slack-ingest.ts; the SQL spelling of
  -- the same pattern, ASCII only).
  select p is not null and cardinality(p) <= 20
     and not exists (
       select 1 from unnest(p) x
        where x is null or char_length(x) > 400
           or x !~ ('^/(tasks|clients|projects)/[A-Za-z0-9_-]{1,100}$'
                    || '|^/inboxes/[A-Za-z0-9_-]{1,100}[?]([^#[:space:]]*&)?thread=[A-Za-z0-9_.:-]{1,200}(&[^#[:space:]]*)?$'));
$$;

-- ---------------------------------------------------------------------------
-- exec_slack_channels (N1, N2, N7, N11, N12)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_channels (
  principal_id          text not null references public.exec_principals(id) on delete cascade,
  installation_id       text not null references public.exec_slack_installations(id) on delete cascade,
  channel_id            text not null constraint exec_slack_channels_id_check check (channel_id ~ '^[CGD][A-Z0-9]{2,30}$'),
  conv_type             text not null constraint exec_slack_channels_type_check check (conv_type in ('channel', 'group', 'im', 'mpim')),
  class                 text not null default 'unclassified'
                          constraint exec_slack_channels_class_check
                          check (class in ('unclassified', 'deny', 'hub', 'finance', 'external', 'standard')),
  deny_reason           text constraint exec_slack_channels_reason_check
                          check (deny_reason is null or deny_reason in
                                 ('assistant_dm', 'dd_bot_dm', 'self_dm', 'bot_im', 'fb_list', 'lead_name')),
  hub_kind              text constraint exec_slack_channels_hub_kind_check
                          check (hub_kind is null or hub_kind in ('outbound', 'client_email')),
  -- C10/C45: the finance name rule, whatever the class (a Slack Connect channel shared with an outside accountant,
  -- payroll provider or lawyer stays class 'external' but gets every finance protection through this flag).
  finance_name          boolean not null default false,
  watch_state           text not null default 'unwatched'
                          constraint exec_slack_channels_watch_check check (watch_state in ('watched', 'muted', 'unwatched')),
  mute_source           text constraint exec_slack_channels_mute_source_check
                          check (mute_source is null or mute_source in ('owner', 'default_finance', 'slack')),
  watch_set_by_owner_at timestamptz,
  -- Metadata only (never logged); null for every deny row.
  name                  text constraint exec_slack_channels_name_check check (name is null or name ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  im_user_id            text constraint exec_slack_channels_im_user_check check (im_user_id is null or im_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  is_member             boolean not null default false,
  is_private            boolean not null default true,
  is_ext_shared         boolean not null default false,
  ext_ever              boolean not null default false,
  is_archived           boolean not null default false,
  hist_watermark_ts     text constraint exec_slack_channels_wm_check check (hist_watermark_ts is null or hist_watermark_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  deep_swept_at         timestamptz,
  swept_at              timestamptz,
  last_event_ts         text constraint exec_slack_channels_event_ts_check check (last_event_ts is null or last_event_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  last_activity_ts      text constraint exec_slack_channels_activity_ts_check check (last_activity_ts is null or last_activity_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  activity_30d          integer constraint exec_slack_channels_activity_check check (activity_30d is null or activity_30d between 0 and 100000),
  probed_at             timestamptz,
  classified_at         timestamptz,
  seen_at               timestamptz,
  left_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint exec_slack_channels_pkey primary key (principal_id, channel_id),
  -- N1: a deny row is a bare marker.
  constraint exec_slack_channels_deny_check check (class <> 'deny' or (
    deny_reason is not null and name is null and im_user_id is null and watch_state = 'unwatched'
    and mute_source is null and watch_set_by_owner_at is null and not is_ext_shared and not finance_name
    and hist_watermark_ts is null and deep_swept_at is null and swept_at is null and last_event_ts is null
    and last_activity_ts is null and activity_30d is null and probed_at is null)),
  constraint exec_slack_channels_reason_pair_check check ((class = 'deny') = (deny_reason is not null)),
  constraint exec_slack_channels_hub_pair_check check ((class = 'hub') = (hub_kind is not null)),
  constraint exec_slack_channels_unclassified_check
    check (class <> 'unclassified' or (watch_state = 'unwatched' and name is null and not finance_name)),
  -- C45: class finance implies the flag; the flag lives only on named finance/external channels.
  constraint exec_slack_channels_finance_name_check
    check ((class <> 'finance' or finance_name)
           and (not finance_name or (conv_type in ('channel', 'group') and class in ('finance', 'external')))),
  constraint exec_slack_channels_mute_pair_check check ((watch_state = 'muted') = (mute_source is not null)),
  constraint exec_slack_channels_im_check check (im_user_id is null or conv_type = 'im'),
  constraint exec_slack_channels_private_check check (conv_type = 'channel' or is_private),
  constraint exec_slack_channels_ext_ever_check check (not is_ext_shared or ext_ever),
  -- N10: a shared conversation is never standard or finance.
  constraint exec_slack_channels_external_check check (not (is_ext_shared and class in ('standard', 'finance')))
);
create index if not exists exec_slack_channels_installation_idx on public.exec_slack_channels (installation_id);
-- The sweep's targets: watched rows, and rows he or Slack muted (their DMs and mentions bypass the mute, N11, so the
-- sweep is their backstop too); never N1's finance default mute.
create index if not exists exec_slack_channels_sweep_idx
  on public.exec_slack_channels (principal_id, swept_at nulls first)
  where watch_state = 'watched' or (watch_state = 'muted' and mute_source in ('owner', 'slack'));
create index if not exists exec_slack_channels_unclassified_idx
  on public.exec_slack_channels (principal_id) where class = 'unclassified';
create index if not exists exec_slack_channels_probe_idx
  on public.exec_slack_channels (principal_id, probed_at nulls first)
  where conv_type = 'channel' and class in ('standard', 'external') and not is_member;

-- ---------------------------------------------------------------------------
-- exec_slack_threads (N6, N8 his-thread; C38)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_threads (
  principal_id         text not null,
  channel_id           text not null,
  thread_ts            text not null constraint exec_slack_threads_ts_check check (thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  he_posted_ts         text constraint exec_slack_threads_he_check check (he_posted_ts is null or he_posted_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  reply_watermark_ts   text constraint exec_slack_threads_wm_check check (reply_watermark_ts is null or reply_watermark_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  latest_reply_seen_ts text constraint exec_slack_threads_latest_check check (latest_reply_seen_ts is null or latest_reply_seen_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  expires_at           timestamptz not null,
  updated_at           timestamptz not null default now(),
  constraint exec_slack_threads_pkey primary key (principal_id, channel_id, thread_ts),
  constraint exec_slack_threads_channel_fkey foreign key (principal_id, channel_id)
    references public.exec_slack_channels (principal_id, channel_id) on update cascade on delete cascade
);
create index if not exists exec_slack_threads_expires_idx on public.exec_slack_threads (expires_at);

-- ---------------------------------------------------------------------------
-- exec_slack_messages (N7: candidates, items and anchors only)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_messages (
  principal_id    text not null,
  channel_id      text not null,
  ts              text not null constraint exec_slack_messages_ts_check check (ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  -- null for a top-level message (normalized: a parent's own thread_ts = ts is stored null).
  thread_ts       text constraint exec_slack_messages_thread_check check (thread_ts is null or (thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$' and thread_ts <> ts)),
  role            text not null constraint exec_slack_messages_role_check check (role in ('candidate', 'item', 'anchor')),
  author_user_id  text constraint exec_slack_messages_author_check check (author_user_id is null or author_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  author_external boolean not null default false,
  is_dd_post      boolean not null default false,
  -- C46 (N18 for P7b): DD-relative paths of the DD links in the message (DD ids, never Slack text), <= 20.
  -- The name of the CHECK is the one P7b's v1 fallback guarded on, so P7b's old block would be a no-op.
  dd_paths        text[] not null default '{}'
                    constraint exec_slack_messages_dd_paths_check check (public.exec_slack_dd_paths_ok(dd_paths)),
  -- bit 1 = DM / group DM, 2 = explicit mention, 4 = reply in his thread (N8).
  reasons         smallint not null default 0 constraint exec_slack_messages_reasons_check check (reasons between 0 and 7),
  triage_state    text not null default 'pending'
                    constraint exec_slack_messages_state_check
                    check (triage_state in ('pending', 'assessed', 'unassessed', 'refused', 'failed', 'skipped', 'none')),
  content_hash    text constraint exec_slack_messages_hash_check check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  edited_ts       text constraint exec_slack_messages_edited_check check (edited_ts is null or edited_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  responded_ts    text constraint exec_slack_messages_responded_check check (responded_ts is null or responded_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  responded_at    timestamptz,
  acknowledged_at timestamptz,
  assessed_at     timestamptz,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint exec_slack_messages_pkey primary key (principal_id, channel_id, ts),
  constraint exec_slack_messages_channel_fkey foreign key (principal_id, channel_id)
    references public.exec_slack_channels (principal_id, channel_id) on update cascade on delete cascade,
  constraint exec_slack_messages_anchor_check check ((role = 'anchor') = is_dd_post),
  constraint exec_slack_messages_anchor_state_check
    check (role <> 'anchor' or (reasons = 0 and triage_state = 'none' and responded_ts is null and author_user_id is null)),
  constraint exec_slack_messages_candidate_state_check check (role = 'anchor' or (triage_state <> 'none' and reasons > 0)),
  constraint exec_slack_messages_responded_pair_check check ((responded_ts is null) = (responded_at is null))
);
create index if not exists exec_slack_messages_expires_idx on public.exec_slack_messages (expires_at);
create index if not exists exec_slack_messages_pending_idx
  on public.exec_slack_messages (principal_id, channel_id, thread_ts) where triage_state = 'pending';
create index if not exists exec_slack_messages_thread_idx
  on public.exec_slack_messages (principal_id, channel_id, thread_ts) where thread_ts is not null;

-- ---------------------------------------------------------------------------
-- exec_slack_items (N7, N8, N9, N10; the excerpt's only home)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_items (
  id                   text primary key default ('esl_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id         text not null,
  channel_id           text not null,
  ts                   text not null,
  kind                 text not null constraint exec_slack_items_kind_check
                         check (kind in ('request', 'question', 'decision', 'commitment', 'action_item', 'fyi')),
  thread_ts            text constraint exec_slack_items_thread_check check (thread_ts is null or thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  author_user_id       text constraint exec_slack_items_author_check check (author_user_id is null or author_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  author_label         text constraint exec_slack_items_label_check check (author_label is null or char_length(author_label) between 1 and 80),
  author_external      boolean not null default false,
  assessed             boolean not null,
  addressed_to_you     boolean not null default false,
  needs_response       boolean not null default false,
  bypass_mute          boolean not null default false,
  urgency              text not null default 'normal' constraint exec_slack_items_urgency_check
                         check (urgency in ('critical', 'high', 'normal', 'low')),
  summary              text constraint exec_slack_items_summary_check check (summary is null or char_length(summary) between 1 and 200),
  excerpt              text constraint exec_slack_items_excerpt_check check (excerpt is null or char_length(excerpt) between 1 and 280),
  due_text             text constraint exec_slack_items_due_text_check check (due_text is null or char_length(due_text) between 1 and 60),
  due_at               timestamptz,
  commitment_direction text constraint exec_slack_items_direction_check
                         check (commitment_direction is null or commitment_direction in ('mitchell_owes', 'owed_to_mitchell')),
  source_class         text not null constraint exec_slack_items_class_check check (source_class in ('public', 'private', 'finance')),
  permalink            text constraint exec_slack_items_permalink_check
                         check (permalink is null or (char_length(permalink) <= 500
                                and permalink ~ '^https://[a-z0-9][a-z0-9-]*\.slack\.com/archives/[CGD][A-Z0-9]{2,30}/p[0-9]{10,20}')),
  responded_ts         text constraint exec_slack_items_responded_check check (responded_ts is null or responded_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  responded_at         timestamptz,
  acknowledged_at      timestamptz,
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint exec_slack_items_key unique (principal_id, channel_id, ts, kind),
  constraint exec_slack_items_message_fkey foreign key (principal_id, channel_id, ts)
    references public.exec_slack_messages (principal_id, channel_id, ts) on update cascade on delete cascade,
  -- N10: an external author's words are never stored verbatim.
  constraint exec_slack_items_external_check check (not author_external or excerpt is null),
  constraint exec_slack_items_commitment_check check ((kind = 'commitment') = (commitment_direction is not null)),
  constraint exec_slack_items_due_check check (due_at is null or kind = 'commitment'),
  -- C41: a not-assessed item is a bare deterministic request.
  constraint exec_slack_items_unassessed_check
    check (assessed or (kind = 'request' and summary is null and excerpt is null and due_text is null)),
  constraint exec_slack_items_responded_pair_check check ((responded_ts is null) = (responded_at is null))
);
create index if not exists exec_slack_items_expires_idx on public.exec_slack_items (expires_at);
create index if not exists exec_slack_items_open_idx
  on public.exec_slack_items (principal_id, created_at desc) where responded_at is null and kind <> 'fyi';
create index if not exists exec_slack_items_channel_idx on public.exec_slack_items (principal_id, channel_id, ts);

-- ---------------------------------------------------------------------------
-- exec_slack_deleted (N7 deleted markers). No FK to channels on purpose: a marker must outlive a purged
-- conversation while a triage job may still be in flight.
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_deleted (
  principal_id text not null references public.exec_principals(id) on delete cascade,
  channel_id   text not null constraint exec_slack_deleted_channel_check check (channel_id ~ '^[CGD][A-Z0-9]{2,30}$'),
  ts           text not null constraint exec_slack_deleted_ts_check check (ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  -- 'tombstone': a deleted thread parent that keeps its replies (seen as message_changed -> tombstone, or in history).
  reason       text not null constraint exec_slack_deleted_reason_check check (reason in ('event', 'absent', 'tombstone')),
  deleted_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint exec_slack_deleted_pkey primary key (principal_id, channel_id, ts),
  -- N7: at least 25 h (Slack's Delayed Events window); the writer uses 26 h.
  constraint exec_slack_deleted_ttl_check check (expires_at >= deleted_at + interval '25 hours')
);
create index if not exists exec_slack_deleted_expires_idx on public.exec_slack_deleted (expires_at);

-- ---------------------------------------------------------------------------
-- exec_slack_rate (N6; C13)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_rate (
  team_id       text not null constraint exec_slack_rate_team_check check (team_id ~ '^T[A-Z0-9]{2,30}$'),
  method        text not null constraint exec_slack_rate_method_check check (method in
                  ('conversations.history', 'conversations.replies', 'conversations.info', 'users.conversations',
                   'conversations.list', 'users.list', 'users.info', 'chat.getPermalink')),
  window_start  timestamptz not null,
  n_total       integer not null default 0 constraint exec_slack_rate_total_check check (n_total between 0 and 1000),
  n_triage      integer not null default 0,
  n_sweep       integer not null default 0,
  n_probe       integer not null default 0,
  n_discovery   integer not null default 0,
  blocked_until timestamptz,
  updated_at    timestamptz not null default now(),
  constraint exec_slack_rate_pkey primary key (team_id, method),
  constraint exec_slack_rate_sum_check check (n_triage + n_sweep + n_probe + n_discovery = n_total)
);

-- ---------------------------------------------------------------------------
-- exec_slack_dd_bot (N3; C28)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_dd_bot (
  team_id    text primary key constraint exec_slack_dd_bot_team_check check (team_id ~ '^T[A-Z0-9]{2,30}$'),
  ok         boolean not null,
  user_id    text constraint exec_slack_dd_bot_user_check check (user_id is null or user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  bot_id     text constraint exec_slack_dd_bot_bot_check check (bot_id is null or bot_id ~ '^B[A-Z0-9]{2,30}$'),
  app_id     text constraint exec_slack_dd_bot_app_check check (app_id is null or app_id ~ '^A[A-Z0-9]{2,30}$'),
  error_code text constraint exec_slack_dd_bot_error_check check (error_code is null or error_code ~ '^[a-z_]{1,60}$'),
  checked_at timestamptz not null,
  constraint exec_slack_dd_bot_ok_check check (ok = (user_id is not null and bot_id is not null and error_code is null))
);

-- ---------------------------------------------------------------------------
-- exec_slack_purge_log (N13 follow-ups; C31)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_purge_log (
  id           bigint generated always as identity primary key,
  principal_id text not null references public.exec_principals(id) on delete cascade,
  scope        text not null constraint exec_slack_purge_log_scope_check check (scope in ('message', 'conversation', 'reading')),
  channel_id   text constraint exec_slack_purge_log_channel_check check (channel_id is null or channel_id ~ '^[CGD][A-Z0-9]{2,30}$'),
  ts           text constraint exec_slack_purge_log_ts_check check (ts is null or ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  reason       text not null constraint exec_slack_purge_log_reason_check check (reason ~ '^[a-z_]{1,40}$'),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  constraint exec_slack_purge_log_shape_check check (
    (scope = 'message' and channel_id is not null and ts is not null)
    or (scope = 'conversation' and channel_id is not null and ts is null)
    or (scope = 'reading' and channel_id is null and ts is null))
);
create index if not exists exec_slack_purge_log_principal_idx on public.exec_slack_purge_log (principal_id, id);
create index if not exists exec_slack_purge_log_expires_idx on public.exec_slack_purge_log (expires_at);

-- ---------------------------------------------------------------------------
-- exec_slack_author_optouts (C44: per-author deletion requests). Refs only: a Slack user id and a time. Written
-- only by exec_slack_purge_author; never expires (a deletion request stands until the owner removes the row by hand
-- after the person withdraws it). Survives Stop reading and re-consent.
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_author_optouts (
  principal_id   text not null references public.exec_principals(id) on delete cascade,
  author_user_id text not null constraint exec_slack_author_optouts_author_check check (author_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  created_at     timestamptz not null default now(),
  constraint exec_slack_author_optouts_pkey primary key (principal_id, author_user_id)
);

-- ---------------------------------------------------------------------------
-- Helpers (1-5, 21, 22)
-- ---------------------------------------------------------------------------

-- 1. p_ingest: the reading facts v2 accepts (P7-2; C1). An allow-listed key set, each value an id, ts, enum, boolean or
--    small integer matching its pattern; any other key, a wrong type or a longer string raises. Never Slack text.
drop function if exists public.exec_slack_ingest_check(jsonb);
create or replace function public.exec_slack_ingest_check(p jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  e jsonb;
  c_ts   constant text := '^[0-9]{1,12}\.[0-9]{1,8}$';
  c_user constant text := '^[UW][A-Z0-9]{2,30}$';
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'exec_slack_ingest_check: not an object'; end if;
  if p ->> 'kind' is null then raise exception 'exec_slack_ingest_check: kind required'; end if;
  for k, v in select key, value from jsonb_each(p) loop
    if jsonb_typeof(v) = 'null' then continue; end if;
    case k
      when 'kind' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' not in ('msg', 'edit', 'delete', 'lifecycle') then raise exception 'exec_slack_ingest_check: kind'; end if;
      when 'conv' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' not in ('channel', 'group', 'im', 'mpim') then raise exception 'exec_slack_ingest_check: conv'; end if;
      when 'lc' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' not in ('created', 'rename', 'archive', 'unarchive', 'deleted', 'left',
                                                              'shared', 'unshared', 'id_changed') then
          raise exception 'exec_slack_ingest_check: lc';
        end if;
      when 'ts', 'thread_ts', 'edited_ts', 'deleted_ts' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ c_ts then raise exception 'exec_slack_ingest_check: ts'; end if;
      when 'author', 'parent_user', 'auth_user' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ c_user then raise exception 'exec_slack_ingest_check: user'; end if;
      when 'author_team' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ '^[TE][A-Z0-9]{2,30}$' then raise exception 'exec_slack_ingest_check: team'; end if;
      when 'app_id' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ '^A[A-Z0-9]{2,30}$' then raise exception 'exec_slack_ingest_check: app'; end if;
      when 'new_channel' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ '^[CGD][A-Z0-9]{2,30}$' then raise exception 'exec_slack_ingest_check: channel'; end if;
      when 'name' then
        if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ '^[a-z0-9][a-z0-9._-]{0,79}$' then raise exception 'exec_slack_ingest_check: name'; end if;
      when 'is_bot', 'dd_template', 'broadcast', 'question', 'files', 'ext_shared', 'auth_is_bot', 'is_ext_shared' then
        if jsonb_typeof(v) <> 'boolean' then raise exception 'exec_slack_ingest_check: flag'; end if;
      when 'len' then
        if jsonb_typeof(v) <> 'number' or v #>> '{}' !~ '^[0-3]$' then raise exception 'exec_slack_ingest_check: len'; end if;
      when 'hints' then
        if jsonb_typeof(v) <> 'number' or v #>> '{}' !~ '^[0-7]$' then raise exception 'exec_slack_ingest_check: hints'; end if;
      when 'mentions' then
        if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20 then raise exception 'exec_slack_ingest_check: mentions'; end if;
        for e in select value from jsonb_array_elements(v) loop
          if jsonb_typeof(e) <> 'string' or e #>> '{}' !~ c_user then raise exception 'exec_slack_ingest_check: mention'; end if;
        end loop;
      when 'dd_paths' then
        -- C46: DD-relative link paths only (the same rule as the column's CHECK).
        if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20 then raise exception 'exec_slack_ingest_check: dd_paths'; end if;
        for e in select value from jsonb_array_elements(v) loop
          if jsonb_typeof(e) <> 'string' then raise exception 'exec_slack_ingest_check: dd_path'; end if;
        end loop;
        if not public.exec_slack_dd_paths_ok(array(select jsonb_array_elements_text(v))) then
          raise exception 'exec_slack_ingest_check: dd_path';
        end if;
      else
        raise exception 'exec_slack_ingest_check: unknown key';
    end case;
  end loop;
end;
$$;

-- 2. The token half of N1's name rule (C37, fail closed; the SQL twin of isLeadName's token half).
drop function if exists public.exec_slack_lead_name(text);
create or replace function public.exec_slack_lead_name(p_name text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  -- A token (split on - _ .) vob / nonvob / calendly / failsafe; zap then error(s); fb next to lead(s). That covers
  -- N1's suffixes, -non-vob-leads and the legacy SOP suffixes -fb-leads-vob, -fb-leads-non-vob, -calendly-call-booked,
  -- -failsafe. The "leads + client slug" half needs the client list, so it lives in slack-classes.ts; v2 treats any
  -- rename containing "leads" as unclassified (C23).
  select p_name is not null and (
       p_name ~ '(^|[-_.])(vob|nonvob|calendly|failsafe)([-_.]|$)'
    or p_name ~ '(^|[-_.])zap[-_.]errors?([-_.]|$)'
    or p_name ~ '(^|[-_.])fb[-_.]leads?([-_.]|$)'
    or p_name ~ '(^|[-_.])leads?[-_.]fb([-_.]|$)');
$$;

-- 3. N1: the FB lead channels, from the ONE key (fb-onboarding.ts SLACK_CHANNELS_KEY). Reads a DD table; called from TS
--    only through sources/dd.ts listFbLeadChannels, and in SQL only by v2's rename branch (C23). A missing
--    fb_onboarding raises 42P01 at call time (discovery aborts; v2 resets the row to unclassified).
drop function if exists public.exec_slack_fb_lead_channels();
create or replace function public.exec_slack_fb_lead_channels()
returns table (name text, channel_id text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_raw  text;
  v_list jsonb;
  v_e    jsonb;
  v_name text;
begin
  -- Selects ONLY state->'access.notify.slack_channels'->>'v' (a JSON string of [{name,url}], <= 12): the EIN, CRM
  -- logins and every other key never leave the database.
  for v_raw in
    select o.state -> 'access.notify.slack_channels' ->> 'v' from public.fb_onboarding o
     where o.state ? 'access.notify.slack_channels'
  loop
    begin
      v_list := v_raw::jsonb;
    exception when others then
      continue;   -- malformed: parseChannels reads it as no channels
    end;
    if v_list is null or jsonb_typeof(v_list) <> 'array' then continue; end if;
    for v_e in select value from jsonb_array_elements(v_list) limit 12 loop
      if jsonb_typeof(v_e) <> 'object' then continue; end if;
      -- The names are hand-typed (spaces, dashes of any kind, trailing punctuation): returned in channelSlug's form
      -- (slack-classes.ts: lower case, every run of anything but a-z / 0-9 one '-', trimmed of '-'), never dropped for
      -- their shape, so the list-based deny can't fail open on a typo. v2's rename branch compares slugs too.
      v_name := btrim(regexp_replace(lower(coalesce(v_e ->> 'name', '')), '[^a-z0-9]+', '-', 'g'), '-');
      name := case when v_name ~ '^[a-z0-9][a-z0-9-]{0,79}$' then v_name end;
      -- Both URL shapes people paste: https://<ws>.slack.com/archives/C... and https://app.slack.com/client/T.../C....
      channel_id := coalesce(substring(coalesce(v_e ->> 'url', '') from '/archives/([CG][A-Z0-9]{2,30})'),
                             substring(coalesce(v_e ->> 'url', '') from '/client/T[A-Z0-9]+/([CG][A-Z0-9]{2,30})'));
      if name is not null or channel_id is not null then return next; end if;
    end loop;
  end loop;
end;
$$;

-- 4. One Slack attention pass a moment after the minute ends (the shape of P3's attentionKick).
drop function if exists public.exec_slack_kick_attention(text);
create or replace function public.exec_slack_kick_attention(p_principal text)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts, run_after)
  values ('exec.slack-attention', 'bulk', p_principal, '{"kick": true}'::jsonb,
          'slack-attn:' || p_principal || ':m' || (floor(extract(epoch from now()) / 60)::bigint + 1)::text, 3,
          to_timestamp((floor(extract(epoch from now()) / 60)::bigint + 1) * 60) + interval '2 seconds')
  on conflict (dedupe_key) do nothing;
$$;

-- 5. C6: insert-first dedupe for every reading event that writes. No channel, ts or text; his id only (P6 C47).
drop function if exists public.exec_slack_record_event(text, text, text, text, text, text, text, text, timestamptz, integer, text);
create or replace function public.exec_slack_record_event(p_event_id text, p_installation_id text, p_principal text,
  p_team text, p_app text, p_type text, p_decision text, p_outcome text, p_time timestamptz, p_retry integer, p_his_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted text;
begin
  insert into public.exec_slack_events (event_id, installation_id, principal_id, team_id, api_app_id, event_type, decision,
                                        ingest_outcome, event_time, retry_num, slack_user_id)
  values (p_event_id, p_installation_id, p_principal, left(p_team, 40), left(p_app, 40),
          case when p_type ~ '^[a-z_.]{1,60}$' then p_type else 'unknown' end, p_decision, p_outcome, p_time,
          least(greatest(coalesce(p_retry, 0), 0), 100), p_his_id)
  on conflict (event_id) do nothing
  returning event_id into v_inserted;
  return v_inserted is not null;
end;
$$;

-- 21. The SQL twin of isFinanceName (slack-classes.ts). Used by v2's rename branch (C23).
drop function if exists public.exec_slack_finance_name(text);
create or replace function public.exec_slack_finance_name(p_name text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_name is not null and p_name ~ ('(^|[-_.])(finance|financial|payroll|accounting|bookkeeping|invoices?|billing|'
                                          || 'tax(es)?|hr|people-?ops|legal|contracts?|compliance|salary|salaries)([-_.]|$)');
$$;

-- 22. C45: the one source_class expression (TS twin: itemSourceClass, triage/slack.ts). Unknown inputs fail toward
--     non-public.
drop function if exists public.exec_slack_item_source_class(text, text, boolean, boolean, boolean, boolean);
create or replace function public.exec_slack_item_source_class(p_conv_type text, p_class text, p_is_private boolean,
                                                               p_ext_ever boolean, p_is_ext_shared boolean, p_finance_name boolean)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_class = 'finance' or coalesce(p_finance_name, false) then 'finance'
    when p_conv_type = 'channel' and p_class = 'standard' and not coalesce(p_is_private, true)
         and not coalesce(p_ext_ever, true) and not coalesce(p_is_ext_shared, true) then 'public'
    else 'private' end;
$$;

-- ---------------------------------------------------------------------------
-- 9. exec_slack_purge_conversation (N13: left, deleted, lost access, deny, gone)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_purge_conversation(text, text, text);
create or replace function public.exec_slack_purge_conversation(p_principal text, p_channel text, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_items   integer;
  v_msgs    integer;
  v_threads integer;
  v_attn    integer;
  v_leave   boolean := p_reason in ('left', 'lost_access');
begin
  if p_reason is null or p_reason not in ('left', 'lost_access', 'deleted', 'deny', 'gone', 'reinstall', 'rekey', 'author_optout') then
    raise exception 'exec_slack_purge_conversation: bad reason';
  end if;
  if p_channel is null or p_channel !~ '^[CGD][A-Z0-9]{2,30}$' then raise exception 'exec_slack_purge_conversation: bad channel'; end if;
  -- C50: the channel row before any message row (a triage writer holding it FOR SHARE finishes first; its items go below).
  perform 1 from public.exec_slack_channels where principal_id = p_principal and channel_id = p_channel for update;
  delete from public.exec_slack_items where principal_id = p_principal and channel_id = p_channel;
  get diagnostics v_items = row_count;
  delete from public.exec_slack_messages where principal_id = p_principal and channel_id = p_channel;
  get diagnostics v_msgs = row_count;
  delete from public.exec_slack_threads where principal_id = p_principal and channel_id = p_channel;
  get diagnostics v_threads = row_count;
  delete from public.exec_attention_items
   where principal_id = p_principal and source = 'slack' and starts_with(fingerprint, 'slack:msg:' || p_channel || ':');
  get diagnostics v_attn = row_count;
  update public.exec_slack_channels
     set hist_watermark_ts = null, deep_swept_at = null, swept_at = null, last_event_ts = null, last_activity_ts = null,
         activity_30d = null, probed_at = null,
         left_at = case when v_leave then now() else left_at end,
         is_member = case when v_leave then false else is_member end,
         watch_state = case when v_leave and class <> 'deny' then 'unwatched' else watch_state end,
         mute_source = case when v_leave then null else mute_source end,
         watch_set_by_owner_at = case when v_leave then null else watch_set_by_owner_at end,
         updated_at = now()
   where principal_id = p_principal and channel_id = p_channel;
  insert into public.exec_slack_purge_log (principal_id, scope, channel_id, reason)
  values (p_principal, 'conversation', p_channel, p_reason);
  if v_attn > 0 then perform public.exec_slack_kick_attention(p_principal); end if;
  return jsonb_build_object('items', v_items, 'messages', v_msgs, 'threads', v_threads, 'attention', v_attn);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. exec_slack_mark_deleted (N7, N13; the delete half of the race). The channel row FOR SHARE, then message rows (C50);
--    nothing in a deny conversation (N1).
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_mark_deleted(text, text, text[], text);
create or replace function public.exec_slack_mark_deleted(p_principal text, p_channel text, p_ts text[], p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ts    text;
  v_class text;
  v_n     integer;
  v_items integer := 0;
  v_msgs  integer := 0;
  v_attn  integer := 0;
begin
  if p_reason is null or p_reason not in ('event', 'absent', 'tombstone') then raise exception 'exec_slack_mark_deleted: bad reason'; end if;
  if p_channel is null or p_channel !~ '^[CGD][A-Z0-9]{2,30}$' then raise exception 'exec_slack_mark_deleted: bad channel'; end if;
  if p_ts is null or cardinality(p_ts) > 500 then raise exception 'exec_slack_mark_deleted: 1..500 ts values'; end if;
  -- C50: the channel row (FOR SHARE) before any message row. N1, rule 7: a deny conversation holds nothing but its bare
  -- marker, so a sweep's or a triage job's delete that lands after a class change to deny writes no marker and no
  -- purge-log row there (a deny that commits later waits for us and purges whatever we leave).
  select c.class into v_class from public.exec_slack_channels c
   where c.principal_id = p_principal and c.channel_id = p_channel for share;
  if v_class = 'deny' then
    return jsonb_build_object('items', 0, 'messages', 0, 'attention', 0);
  end if;
  foreach v_ts in array p_ts loop
    if v_ts is null or v_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$' then raise exception 'exec_slack_mark_deleted: bad ts'; end if;
    -- 1. The marker first: a writer that locks the row after this commits sees it (exec_slack_write_items step 2).
    insert into public.exec_slack_deleted (principal_id, channel_id, ts, reason, deleted_at, expires_at)
    values (p_principal, p_channel, v_ts, p_reason, now(), now() + interval '26 hours')
    on conflict (principal_id, channel_id, ts) do update
      set deleted_at = now(), expires_at = greatest(public.exec_slack_deleted.expires_at, now() + interval '26 hours');
    -- 2. Then the message row's lock: a writer holding it commits before our deletes take their snapshot.
    perform 1 from public.exec_slack_messages
     where principal_id = p_principal and channel_id = p_channel and ts = v_ts for update;
    delete from public.exec_slack_items where principal_id = p_principal and channel_id = p_channel and ts = v_ts;
    get diagnostics v_n = row_count; v_items := v_items + v_n;
    delete from public.exec_slack_messages where principal_id = p_principal and channel_id = p_channel and ts = v_ts;
    get diagnostics v_n = row_count; v_msgs := v_msgs + v_n;
    delete from public.exec_attention_items
     where principal_id = p_principal and source = 'slack' and fingerprint = 'slack:msg:' || p_channel || ':' || v_ts;
    get diagnostics v_n = row_count; v_attn := v_attn + v_n;
    insert into public.exec_slack_purge_log (principal_id, scope, channel_id, ts, reason)
    values (p_principal, 'message', p_channel, v_ts, 'deleted_' || p_reason);
  end loop;
  if v_items + v_attn > 0 then perform public.exec_slack_kick_attention(p_principal); end if;
  return jsonb_build_object('items', v_items, 'messages', v_msgs, 'attention', v_attn);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. exec_slack_note_messages (candidates and anchors; v2 and sweeps). Reads the channel row FOR SHARE (C50: the channel
--    row before message rows; v2 already holds it FOR UPDATE): a class change to deny either waits for this note and then
--    purges what it wrote, or is seen committed here and nothing is written (N1, rule 7).
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_note_messages(text, text, jsonb, text, text);
create or replace function public.exec_slack_note_messages(p_principal text, p_channel text, p_rows jsonb, p_lane text, p_bucket text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ch         public.exec_slack_channels%rowtype;
  v_days       integer;
  r            jsonb;
  v_ts         text;
  v_thread     text;
  v_reasons    integer;
  v_state      text;
  v_root       text;
  v_roots      text[] := '{}';
  v_paths      text[];
  v_candidates integer := 0;
  v_anchors    integer := 0;
  v_blocked    integer := 0;
  v_optout     integer := 0;
  v_jobs       integer := 0;
  v_job        bigint;
begin
  if p_lane is null or p_lane not in ('interactive', 'bulk') or p_bucket is null or p_bucket !~ '^[mb][0-9]{1,12}$' then
    raise exception 'exec_slack_note_messages: bad lane or bucket';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'exec_slack_note_messages: rows'; end if;
  select * into v_ch from public.exec_slack_channels c where c.principal_id = p_principal and c.channel_id = p_channel for share;
  if not found or v_ch.class in ('deny', 'unclassified') then
    return jsonb_build_object('candidates', 0, 'anchors', 0, 'blocked', 0, 'opted_out', 0, 'jobs', 0, 'refused', 'class');
  end if;
  select coalesce(s.retention_days_slack, 90) into v_days from public.exec_settings s where s.principal_id = p_principal;
  v_days := coalesce(v_days, 90);
  for r in select value from jsonb_array_elements(p_rows) loop
    v_ts := r ->> 'ts';
    if v_ts is null or v_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$'
       or (r ->> 'thread_ts' is not null and r ->> 'thread_ts' !~ '^[0-9]{1,12}\.[0-9]{1,8}$')
       or r ->> 'role' is null or r ->> 'role' not in ('candidate', 'anchor')
       or (r ->> 'author' is not null and r ->> 'author' !~ '^[UW][A-Z0-9]{2,30}$')
       or (r -> 'dd_paths' is not null and jsonb_typeof(r -> 'dd_paths') not in ('array', 'null')) then
      raise exception 'exec_slack_note_messages: bad row';
    end if;
    v_thread := nullif(r ->> 'thread_ts', v_ts);
    -- C46: DD paths (the CHECK re-validates every element; a bad one raises and the caller's batch is retried).
    v_paths := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(r -> 'dd_paths') = 'array'
                                                                     then r -> 'dd_paths' else '[]'::jsonb end)), '{}');
    if exists (select 1 from public.exec_slack_deleted d where d.principal_id = p_principal
                and d.channel_id = p_channel and d.ts = v_ts) then
      v_blocked := v_blocked + 1; continue;
    end if;
    if r ->> 'role' = 'anchor' then
      -- An anchor's paths are filled in when a later sighting has them (the event may lack the URL buttons a sweep sees).
      insert into public.exec_slack_messages (principal_id, channel_id, ts, thread_ts, role, is_dd_post, triage_state, reasons,
                                              dd_paths, expires_at)
      values (p_principal, p_channel, v_ts, v_thread, 'anchor', true, 'none', 0, v_paths,
              to_timestamp(v_ts::numeric) + make_interval(days => v_days))
      on conflict (principal_id, channel_id, ts) do update
        set dd_paths = excluded.dd_paths, updated_at = now()
        where public.exec_slack_messages.role = 'anchor' and cardinality(excluded.dd_paths) > 0
          and public.exec_slack_messages.dd_paths is distinct from excluded.dd_paths;
      v_anchors := v_anchors + 1;
      continue;
    end if;
    if v_ch.class = 'hub' or v_ch.watch_state = 'unwatched' then continue; end if;    -- C35; N12
    v_reasons := coalesce((r ->> 'reasons')::integer, 0);
    if v_reasons < 1 or v_reasons > 7 then raise exception 'exec_slack_note_messages: bad reasons'; end if;
    -- N11: DMs and mentions bypass an owner's or Slack's mute; N1's finance default mute is never bypassed, and a muted
    -- finance channel (class finance or a finance name, C10) is never bypassed whatever the stored source.
    if v_ch.watch_state = 'muted' and (v_ch.mute_source = 'default_finance' or v_ch.class = 'finance' or v_ch.finance_name
                                       or (v_reasons & 3) = 0) then continue; end if;
    -- C44: an opted-out author is never ingested again.
    if r ->> 'author' is not null and exists (select 1 from public.exec_slack_author_optouts o
                                               where o.principal_id = p_principal and o.author_user_id = r ->> 'author') then
      v_optout := v_optout + 1; continue;
    end if;
    v_state := null;
    insert into public.exec_slack_messages (principal_id, channel_id, ts, thread_ts, role, author_user_id, author_external,
                                            is_dd_post, reasons, triage_state, dd_paths, expires_at)
    values (p_principal, p_channel, v_ts, v_thread, 'candidate', r ->> 'author', coalesce((r ->> 'author_external')::boolean, false),
            false, v_reasons, 'pending', v_paths, to_timestamp(v_ts::numeric) + make_interval(days => v_days))
    on conflict (principal_id, channel_id, ts) do update
      set reasons = (public.exec_slack_messages.reasons | excluded.reasons)::smallint,
          -- C33: once external, always external (fail closed); the newest non-empty paths win (C46).
          author_external = public.exec_slack_messages.author_external or excluded.author_external,
          dd_paths = case when cardinality(excluded.dd_paths) > 0 then excluded.dd_paths else public.exec_slack_messages.dd_paths end,
          updated_at = now()
      where public.exec_slack_messages.role <> 'anchor'
    returning triage_state into v_state;
    if v_state = 'pending' then
      v_root := coalesce(v_thread, case when v_ch.conv_type in ('im', 'mpim') then 'c' else v_ts end);
      if not (v_root = any (v_roots)) then v_roots := v_roots || v_root; end if;
      v_candidates := v_candidates + 1;
    end if;
  end loop;
  foreach v_root in array v_roots loop
    v_job := null;
    insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts, run_after)
    values ('exec.slack-triage', p_lane, p_principal,
            jsonb_build_object('installation_id', v_ch.installation_id, 'channel', p_channel, 'root', v_root, 'mode', 'window'),
            'slack-triage:' || p_principal || ':' || p_channel || ':' || v_root || ':' || p_bucket, 6,
            case when p_lane = 'interactive'
                 then to_timestamp((floor(extract(epoch from now()) / 60)::bigint + 1) * 60) + interval '5 seconds'
                 else now() end)
    on conflict (dedupe_key) do nothing
    returning id into v_job;
    if v_job is not null then v_jobs := v_jobs + 1; end if;
  end loop;
  return jsonb_build_object('candidates', v_candidates, 'anchors', v_anchors, 'blocked', v_blocked, 'opted_out', v_optout,
                            'jobs', v_jobs);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. exec_slack_note_from_him (N9): participation and "answered", no text, no model.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_note_from_him(text, text, jsonb);
create or replace function public.exec_slack_note_from_him(p_principal text, p_channel text, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_conv     text;
  r          jsonb;
  v_ts       text;
  v_thread   text;
  v_mentions text[];
  v_checks   boolean := to_regclass('public.exec_brief_checkins') is not null;
  v_flag     boolean;
  v_n        integer;
  v_stamped  integer := 0;
  v_skipped  integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'exec_slack_note_from_him: rows'; end if;
  -- C50: the channel row FOR SHARE before its thread and message rows. N1, rule 7: a class change to deny either waits for
  -- us and purges the thread row we write, or is seen committed here (the re-checked row no longer qualifies) and nothing
  -- is written.
  select c.conv_type into v_conv from public.exec_slack_channels c
   where c.principal_id = p_principal and c.channel_id = p_channel and c.class not in ('deny', 'unclassified', 'hub') for share;
  if v_conv is null then return jsonb_build_object('stamped', 0, 'skipped', jsonb_array_length(p_rows)); end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_ts := r ->> 'ts';
    if v_ts is null or v_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$' or (r ->> 'thread_ts' is not null and r ->> 'thread_ts' !~ '^[0-9]{1,12}\.[0-9]{1,8}$') then
      raise exception 'exec_slack_note_from_him: bad ts';
    end if;
    v_thread := nullif(r ->> 'thread_ts', v_ts);
    -- C21 (N9): P8's check-ins are posted as him; they are not his answers.
    if v_checks then
      execute 'select exists (select 1 from public.exec_brief_checkins c where c.principal_id = $1 and c.slack_ts = $2)'
        into v_flag using p_principal, v_ts;
      if v_flag then v_skipped := v_skipped + 1; continue; end if;
    end if;
    v_mentions := array(select jsonb_array_elements_text(coalesce(r -> 'mentions', '[]'::jsonb)));
    if exists (select 1 from unnest(v_mentions) m where m !~ '^[UW][A-Z0-9]{2,30}$') or cardinality(v_mentions) > 20 then
      raise exception 'exec_slack_note_from_him: bad mentions';
    end if;
    -- Participation: threads he started or posted in (channels and private channels).
    if v_conv in ('channel', 'group') then
      insert into public.exec_slack_threads (principal_id, channel_id, thread_ts, he_posted_ts, expires_at)
      values (p_principal, p_channel, coalesce(v_thread, v_ts), v_ts, to_timestamp(v_ts::numeric) + interval '14 days')
      on conflict (principal_id, channel_id, thread_ts) do update
        set he_posted_ts = case when public.exec_slack_threads.he_posted_ts is null
                                  or public.exec_slack_threads.he_posted_ts::numeric < excluded.he_posted_ts::numeric
                                then excluded.he_posted_ts else public.exec_slack_threads.he_posted_ts end,
            expires_at = greatest(public.exec_slack_threads.expires_at, excluded.expires_at), updated_at = now();
    end if;
    -- Answered: the same predicate on candidate/item rows and on items.
    update public.exec_slack_messages m set responded_ts = v_ts, responded_at = now(), updated_at = now()
     where m.principal_id = p_principal and m.channel_id = p_channel and m.role <> 'anchor' and m.responded_ts is null
       and m.ts::numeric < v_ts::numeric
       and (v_conv = 'im'
            or (v_thread is not null and coalesce(m.thread_ts, m.ts) = v_thread)
            or (v_thread is null and m.thread_ts is null and v_conv = 'mpim')
            or (v_thread is null and m.thread_ts is null and v_conv in ('channel', 'group') and m.author_user_id = any (v_mentions)));
    get diagnostics v_n = row_count;
    v_stamped := v_stamped + v_n;
    update public.exec_slack_items i set responded_ts = v_ts, responded_at = now(), updated_at = now()
     where i.principal_id = p_principal and i.channel_id = p_channel and i.responded_ts is null
       and i.ts::numeric < v_ts::numeric
       and (v_conv = 'im'
            or (v_thread is not null and coalesce(i.thread_ts, i.ts) = v_thread)
            or (v_thread is null and i.thread_ts is null and v_conv = 'mpim')
            or (v_thread is null and i.thread_ts is null and v_conv in ('channel', 'group') and i.author_user_id = any (v_mentions)));
  end loop;
  if v_stamped > 0 then perform public.exec_slack_kick_attention(p_principal); end if;
  return jsonb_build_object('stamped', v_stamped, 'skipped', v_skipped);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7b. exec_slack_save_thread_watermark (N6's 7-day lookback; C38). The sweep's per-thread reply watermark, written under
--     the channel row's lock (C50) and only where reading may store it (N1, rule 7: never a watermark in a deny
--     conversation, whatever a sweep that read the row before a class change believes). The watermark and the latest
--     reply never move back; expires_at = the later of the stored one and latest + 14 days.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_save_thread_watermark(text, text, text, text, text);
create or replace function public.exec_slack_save_thread_watermark(p_principal text, p_channel text, p_thread_ts text,
                                                                   p_watermark text, p_latest text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_class text;
begin
  if p_channel is null or p_channel !~ '^[CGD][A-Z0-9]{2,30}$' then raise exception 'exec_slack_save_thread_watermark: bad channel'; end if;
  if p_thread_ts is null or p_thread_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$'
     or p_watermark is null or p_watermark !~ '^[0-9]{1,12}\.[0-9]{1,8}$'
     or p_latest is null or p_latest !~ '^[0-9]{1,12}\.[0-9]{1,8}$' then
    raise exception 'exec_slack_save_thread_watermark: bad ts';
  end if;
  -- The channel row FOR SHARE: a class change to deny either waits for this write and purges it, or is seen committed
  -- here and nothing is written. Hubs keep their watermark (their thread replies are read for DD anchors only).
  select c.class into v_class from public.exec_slack_channels c
   where c.principal_id = p_principal and c.channel_id = p_channel for share;
  if v_class is null or v_class not in ('standard', 'external', 'finance', 'hub') then return false; end if;
  insert into public.exec_slack_threads (principal_id, channel_id, thread_ts, reply_watermark_ts, latest_reply_seen_ts, expires_at)
  values (p_principal, p_channel, p_thread_ts, p_watermark, p_latest, to_timestamp(p_latest::numeric) + interval '14 days')
  on conflict (principal_id, channel_id, thread_ts) do update
    set reply_watermark_ts = case when public.exec_slack_threads.reply_watermark_ts is not null
                                       and public.exec_slack_threads.reply_watermark_ts::numeric > excluded.reply_watermark_ts::numeric
                                  then public.exec_slack_threads.reply_watermark_ts else excluded.reply_watermark_ts end,
        latest_reply_seen_ts = case when public.exec_slack_threads.latest_reply_seen_ts is not null
                                         and public.exec_slack_threads.latest_reply_seen_ts::numeric > excluded.latest_reply_seen_ts::numeric
                                    then public.exec_slack_threads.latest_reply_seen_ts else excluded.latest_reply_seen_ts end,
        expires_at = greatest(public.exec_slack_threads.expires_at,
                              to_timestamp(greatest(excluded.latest_reply_seen_ts::numeric,
                                                    coalesce(public.exec_slack_threads.latest_reply_seen_ts::numeric, 0))) + interval '14 days'),
        updated_at = now();
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. exec_slack_accept_event_v2 (N5; the reading ack gate). The order is load-bearing (C43): deletes and edits of
--     stored rows come right after the live-reading-half check, before every gate that can drop a new message.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_accept_event_v2(text, text, text, text, bigint, integer, text, text, text, text, text,
  boolean, boolean, text, boolean, boolean, boolean, text, text[], text[], jsonb);
create or replace function public.exec_slack_accept_event_v2(
  p_event_id text, p_team_id text, p_api_app_id text, p_event_type text, p_event_time bigint, p_retry_num integer,
  p_channel text, p_channel_type text, p_user text, p_ts text, p_thread_ts text,
  p_has_bot_id boolean, p_has_app_id boolean, p_subtype text, p_hidden boolean, p_text_is_string boolean,
  p_has_message boolean, p_tab text, p_revoked_bot_ids text[], p_revoked_user_ids text[],
  p_ingest jsonb    -- the reading facts; null for an event the route sends to the P6 path
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_chan     constant text := '^[CGD][A-Z0-9]{2,30}$';
  v_now      timestamptz := now();
  v_time     timestamptz;
  v_res      jsonb;
  v_inst     public.exec_slack_installations%rowtype;
  v_ch       public.exec_slack_channels%rowtype;
  v_dd       public.exec_slack_dd_bot%rowtype;
  v_have     boolean;
  v_kind     text;
  v_conv     text;
  v_lc       text;
  v_ts       text;
  v_thread   text;
  v_author   text;
  v_mentions text[];
  v_is_dd    boolean;
  v_reasons  integer := 0;
  v_len      integer;
  v_scope    text;
  v_outcome  text;
  v_gates    boolean;
  v_ext      boolean;
  v_fb       boolean;
  v_finance  boolean;
  v_new_name text;
  v_paths    jsonb;
  v_retry    integer := least(greatest(coalesce(p_retry_num, 0), 0), 100);
  v_hour     bigint := floor(extract(epoch from now()) / 3600)::bigint;
begin
  -- 1. P6's input checks (v1 repeats them when called).
  if p_event_id is null or p_event_id !~ '^Ev[A-Za-z0-9]{2,40}$' then raise exception 'exec_slack_accept_event_v2: bad event_id'; end if;
  if p_team_id is null or p_api_app_id is null or p_event_type is null then
    raise exception 'exec_slack_accept_event_v2: team, app and type are required';
  end if;
  if p_event_time is null or p_event_time <= 0 or p_event_time > 4102444800 then
    raise exception 'exec_slack_accept_event_v2: bad event_time';
  end if;
  v_time := to_timestamp(p_event_time);

  -- 2. P6's events, any message in an assistant DM, and anything without reading facts: v1, unchanged (C2).
  if p_ingest is null
     or p_event_type in ('app_home_opened', 'app_uninstalled', 'tokens_revoked')
     or (p_event_type = 'message' and (p_channel is null or exists (
           select 1 from public.exec_slack_installations i
            where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id
              and i.slack_dm_channel_id = p_channel)))
     or p_event_type not in ('message', 'channel_created', 'channel_rename', 'channel_archive', 'channel_unarchive',
                             'channel_deleted', 'channel_left', 'channel_shared', 'channel_unshared', 'channel_id_changed',
                             'group_rename', 'group_archive', 'group_unarchive', 'group_deleted', 'group_left') then
    -- 2a. tokens_revoked naming him: an auth.test check of the user half (C25), before v1 handles the bot half.
    if p_event_type = 'tokens_revoked' and coalesce(cardinality(p_revoked_user_ids), 0) > 0 then
      insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
      select 'exec.slack-user-check', 'bulk', null,
             jsonb_build_object('installation_id', i.id, 'event_time', p_event_time),
             'slack-user-check:' || p_event_id || ':' || i.id, 3
        from public.exec_slack_installations i
       where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id
         and i.user_token_enc is not null and i.user_id = any (p_revoked_user_ids) and i.user_installed_at <= v_time
      on conflict (dedupe_key) do nothing;
      -- C47: a Stop reading whose Slack revoke failed asked him to remove the access in Slack; Slack revoking his token
      -- now is that done, so the "remove the access" banner (user_last_error_code 'revoke_failed') ends.
      update public.exec_slack_installations i
         set user_last_error_code = null, user_last_error_at = null, updated_at = now()
       where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id and i.reading_state = 'revoked'
         and i.user_token_enc is null and i.user_last_error_code = 'revoke_failed' and i.user_id = any (p_revoked_user_ids);
    end if;
    v_res := public.exec_slack_accept_event(p_event_id, p_team_id, p_api_app_id, p_event_type, p_event_time, p_retry_num,
               p_channel, p_channel_type, p_user, p_ts, p_thread_ts, p_has_bot_id, p_has_app_id, p_subtype, p_hidden,
               p_text_is_string, p_has_message, p_tab, p_revoked_bot_ids, p_revoked_user_ids);
    -- 2b. app_uninstalled: the reading half of each installation v1 just revoked is purged by a job (N13).
    if p_event_type = 'app_uninstalled' and v_res ->> 'decision' = 'revoke' then
      insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
      select 'exec.slack-read-purge', 'bulk', null,
             jsonb_build_object('installation_id', i.id, 'reason', 'app_uninstalled'),
             'slack-read-purge:' || i.id || ':' || coalesce(floor(extract(epoch from i.user_installed_at))::bigint::text, '0'), 6
        from public.exec_slack_installations i
       where i.team_id = p_team_id and i.app_id = p_api_app_id and i.revoke_reason = 'app_uninstalled'
         and i.reading_state <> 'none' and i.reading_purged_at is null
      on conflict (dedupe_key) do nothing;
    end if;
    return v_res || jsonb_build_object('path', 'v1');
  end if;

  -- 3. Reading facts: refs and flags only.
  perform public.exec_slack_ingest_check(p_ingest);
  v_kind := p_ingest ->> 'kind';
  if (v_kind = 'lifecycle') <> (p_event_type <> 'message') then
    raise exception 'exec_slack_accept_event_v2: kind and event type disagree';
  end if;
  if p_channel is null or p_channel !~ c_chan then raise exception 'exec_slack_accept_event_v2: bad channel'; end if;
  if v_kind = 'delete' and p_ingest ->> 'deleted_ts' is null then raise exception 'exec_slack_accept_event_v2: deleted_ts required'; end if;
  if v_kind in ('msg', 'edit') and p_ingest ->> 'ts' is null then raise exception 'exec_slack_accept_event_v2: ts required'; end if;
  v_ts := p_ingest ->> 'ts';
  v_thread := nullif(p_ingest ->> 'thread_ts', v_ts);
  v_author := p_ingest ->> 'author';
  v_conv := p_ingest ->> 'conv';
  -- C46: absent and JSON null both mean "no paths" (the check above validated an array).
  v_paths := case when jsonb_typeof(p_ingest -> 'dd_paths') = 'array' then p_ingest -> 'dd_paths' else '[]'::jsonb end;

  -- 4. The reading installation (C7: at most one live reading half per team and app).
  select i.* into v_inst from public.exec_slack_installations i
   where i.revoked_at is null and i.team_id = p_team_id and i.app_id = p_api_app_id and i.user_token_enc is not null;
  if not found then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'not_reading', 'recorded', false, 'path', 'v2');
  end if;
  if coalesce((p_ingest ->> 'auth_is_bot')::boolean, false) or (p_ingest ->> 'auth_user') is distinct from v_inst.user_id then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'not_his_view', 'recorded', false, 'path', 'v2');
  end if;

  select * into v_ch from public.exec_slack_channels c
   where c.principal_id = v_inst.principal_id and c.channel_id = p_channel for update;
  v_have := found;

  -- 4b. Deletes (N13, C43): honoured whatever the switch, discovery, scope or watch state. Deletes only remove data,
  --     so nothing that gates reading gates them. No channel row or a deny row: nothing is stored there. An
  --     unclassified row (a C23 reset may still hold rows): only when a row exists, so a conversation the pending
  --     classify job may deny gets no marker.
  if v_kind = 'delete' then
    if not v_have then
      return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'unknown_channel', 'recorded', false, 'path', 'v2');
    end if;
    if v_ch.class = 'deny' then
      return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'deny', 'recorded', false, 'path', 'v2');
    end if;
    if v_ch.class = 'unclassified' and not exists (
         select 1 from public.exec_slack_messages m where m.principal_id = v_inst.principal_id
            and m.channel_id = p_channel and m.ts = p_ingest ->> 'deleted_ts') then
      return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'unclassified', 'recorded', false, 'path', 'v2');
    end if;
    if not public.exec_slack_record_event(p_event_id, v_inst.id, v_inst.principal_id, p_team_id, p_api_app_id, p_event_type,
                                          'ingest', 'deleted', v_time, v_retry, null) then
      return jsonb_build_object('outcome', 'duplicate', 'path', 'v2');
    end if;
    -- The marker, the rows, the attention row and one 'message' purge-log row, even in an unwatched or muted
    -- conversation: P7b digests and P8 briefs may have used it while it was watched (N15, M9).
    v_res := public.exec_slack_mark_deleted(v_inst.principal_id, p_channel, array[p_ingest ->> 'deleted_ts'], 'event');
    return jsonb_build_object('outcome', 'accepted', 'decision', 'ingest', 'reason', 'deleted', 'recorded', true,
                              'enqueued', false, 'interactive', false, 'path', 'v2') || v_res;
  end if;

  -- 4c. An edit of a stored non-anchor message (C22, C43): its excerpts go now, whatever the switch, discovery, scope,
  --     class (a deny row holds nothing) or watch state. The re-triage is enqueued only when the message gates of
  --     steps 6-9 would pass. An edit of a message DD doesn't hold is handled as a new message below.
  if v_kind = 'edit' and v_have and v_ch.class <> 'deny' and exists (
       select 1 from public.exec_slack_messages m where m.principal_id = v_inst.principal_id
          and m.channel_id = p_channel and m.ts = v_ts and m.role <> 'anchor') then
    if not public.exec_slack_record_event(p_event_id, v_inst.id, v_inst.principal_id, p_team_id, p_api_app_id, p_event_type,
                                          'ingest', 'edited', v_time, v_retry, null) then
      return jsonb_build_object('outcome', 'duplicate', 'path', 'v2');
    end if;
    update public.exec_slack_items set excerpt = null, updated_at = now()
     where principal_id = v_inst.principal_id and channel_id = p_channel and ts = v_ts and excerpt is not null;
    update public.exec_slack_messages
       set edited_ts = case when p_ingest ->> 'edited_ts' is not null
                             and (edited_ts is null or edited_ts::numeric < (p_ingest ->> 'edited_ts')::numeric)
                            then p_ingest ->> 'edited_ts' else edited_ts end,
           dd_paths = case when jsonb_array_length(v_paths) > 0
                           then array(select jsonb_array_elements_text(v_paths)) else dd_paths end,
           updated_at = now()
     where principal_id = v_inst.principal_id and channel_id = p_channel and ts = v_ts;
    v_scope := case v_conv when 'channel' then 'channels:history' when 'group' then 'groups:history'
                           when 'im' then 'im:history' when 'mpim' then 'mpim:history' end;
    v_gates := v_inst.discovered_at is not null
               and coalesce((select s.slack_reading_enabled from public.exec_settings s where s.principal_id = v_inst.principal_id), false)
               and v_scope is not null and v_scope = any (v_inst.user_scopes)
               and v_ch.class in ('standard', 'external', 'finance') and v_ch.watch_state <> 'unwatched' and v_ch.left_at is null
               and not (v_ch.watch_state = 'muted'
                        and (v_ch.mute_source = 'default_finance' or v_ch.class = 'finance' or v_ch.finance_name));
    v_gates := coalesce(v_gates, false);
    if v_gates then
      insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
      values ('exec.slack-triage', 'bulk', v_inst.principal_id,
              jsonb_build_object('installation_id', v_inst.id, 'channel', p_channel, 'root', v_ts, 'mode', 'retriage', 'ts', v_ts),
              'slack-retriage:' || v_inst.principal_id || ':' || p_channel || ':' || v_ts || ':' || coalesce(p_ingest ->> 'edited_ts', v_ts), 6)
      on conflict (dedupe_key) do nothing;
    end if;
    return jsonb_build_object('outcome', 'accepted', 'decision', 'ingest', 'reason', 'edited', 'recorded', true,
                              'enqueued', v_gates, 'interactive', false, 'path', 'v2');
  end if;

  -- 5. Lifecycle (applies while reading is paused too: every change only narrows what is stored).
  if v_kind = 'lifecycle' then
    v_lc := p_ingest ->> 'lc';
    if v_lc is null then raise exception 'exec_slack_accept_event_v2: lc required'; end if;
    if not v_have and v_lc <> 'created' then
      return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'unknown_channel', 'recorded', false, 'path', 'v2');
    end if;
    -- N1, rule 7: a deny conversation holds its bare marker and nothing else, whatever the gate cache's temperature (a warm
    -- snapshot drops these events at the route): no event row, no purge-log row, no job. A deletion removes the marker
    -- itself (nothing else exists to purge); a re-key still moves it, so the new id stays denied until the classifier says
    -- otherwise; every other lifecycle event is dropped unrecorded.
    if v_have and v_ch.class = 'deny' and v_lc <> 'id_changed' then
      if v_lc = 'deleted' then
        delete from public.exec_slack_channels where principal_id = v_inst.principal_id and channel_id = p_channel;
      end if;
      return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'deny', 'recorded', false, 'path', 'v2');
    end if;
    if not public.exec_slack_record_event(p_event_id, v_inst.id, v_inst.principal_id, p_team_id, p_api_app_id, p_event_type,
                                          'lifecycle', v_lc, v_time, v_retry, null) then
      return jsonb_build_object('outcome', 'duplicate', 'path', 'v2');
    end if;
    v_outcome := v_lc;
    if v_lc = 'created' then
      insert into public.exec_slack_channels (principal_id, installation_id, channel_id, conv_type, is_private)
      values (v_inst.principal_id, v_inst.id, p_channel, 'channel', false) on conflict do nothing;
      v_outcome := 'classify';
    elsif v_lc = 'rename' then
      v_new_name := p_ingest ->> 'name';
      v_fb := false;
      if v_ch.class <> 'deny' then
        -- C23: a name (or the channel id) on the FB lead list is denied at once, not after the bulk classify job.
        -- No fb_onboarding table (42P01): a lead channel can't be ruled out, so the row goes unclassified.
        begin
          select exists (select 1 from public.exec_slack_fb_lead_channels() f
                          where f.channel_id = p_channel
                             or (v_new_name is not null
                                 and f.name = btrim(regexp_replace(lower(v_new_name), '[^a-z0-9]+', '-', 'g'), '-'))) into v_fb;
        exception when undefined_table then
          v_fb := null;
        end;
      end if;
      if v_ch.class = 'deny' then
        v_outcome := 'deny_kept';
      elsif v_fb or public.exec_slack_lead_name(v_new_name) then
        -- C23/C37: a listed or lead-token name is denied at once, its rows purged.
        perform public.exec_slack_purge_conversation(v_inst.principal_id, p_channel, 'deny');
        update public.exec_slack_channels
           set class = 'deny', deny_reason = case when v_fb then 'fb_list' else 'lead_name' end, hub_kind = null,
               finance_name = false, watch_state = 'unwatched', mute_source = null,
               watch_set_by_owner_at = null, name = null, im_user_id = null, is_ext_shared = false, hist_watermark_ts = null,
               deep_swept_at = null, swept_at = null, last_event_ts = null, last_activity_ts = null, activity_30d = null,
               probed_at = null, classified_at = now(), updated_at = now()
         where principal_id = v_inst.principal_id and channel_id = p_channel;
        v_outcome := 'denied';
      elsif v_fb is null or v_new_name is null or v_new_name ~ 'leads' then
        -- Fail closed: an unreadable FB list, a name outside the name pattern, or any "leads" name waits for the classifier.
        update public.exec_slack_channels
           set class = 'unclassified', deny_reason = null, hub_kind = null, finance_name = false, watch_state = 'unwatched',
               mute_source = null, watch_set_by_owner_at = null, name = null, updated_at = now()
         where principal_id = v_inst.principal_id and channel_id = p_channel;
        v_outcome := 'classify';
      else
        -- C10/C45: a rename INTO a finance name gets the finance default now (the owner's earlier choice is reset).
        v_finance := v_ch.class in ('standard', 'external', 'finance') and v_ch.conv_type in ('channel', 'group')
                     and not v_ch.finance_name and public.exec_slack_finance_name(v_new_name);
        update public.exec_slack_channels
           set name = case when class = 'unclassified' then null else v_new_name end,
               finance_name = finance_name or v_finance,
               class = case when v_finance and class = 'standard' then 'finance' else class end,
               watch_state = case when v_finance and watch_state in ('watched', 'muted') then 'muted' else watch_state end,
               mute_source = case when v_finance and watch_state in ('watched', 'muted') then 'default_finance' else mute_source end,
               watch_set_by_owner_at = case when v_finance then null else watch_set_by_owner_at end,
               updated_at = now()
         where principal_id = v_inst.principal_id and channel_id = p_channel;
        if v_finance then
          update public.exec_slack_items set source_class = 'finance', updated_at = now()
           where principal_id = v_inst.principal_id and channel_id = p_channel and source_class <> 'finance';
        end if;
        v_outcome := 'classify';
      end if;
    elsif v_lc in ('archive', 'unarchive') then
      update public.exec_slack_channels set is_archived = (v_lc = 'archive'), updated_at = now()
       where principal_id = v_inst.principal_id and channel_id = p_channel;
    elsif v_lc = 'deleted' then
      perform public.exec_slack_purge_conversation(v_inst.principal_id, p_channel, 'deleted');
      delete from public.exec_slack_channels where principal_id = v_inst.principal_id and channel_id = p_channel;
      v_outcome := 'purged';
    elsif v_lc = 'left' then
      perform public.exec_slack_purge_conversation(v_inst.principal_id, p_channel, 'left');
      v_outcome := 'purged';
    elsif v_lc = 'shared' then
      if v_ch.class <> 'deny' then
        -- An unclassified row stays unclassified (its pending classify job decides, deny first); the flags move now.
        -- A finance channel keeps finance_name (and so its finance protections) as class 'external'.
        update public.exec_slack_channels
           set class = case when class in ('standard', 'finance') then 'external' else class end,
               is_ext_shared = true, ext_ever = true, updated_at = now()
         where principal_id = v_inst.principal_id and channel_id = p_channel;
        -- C45: every item re-derived from the updated row (public -> private; finance stays finance).
        update public.exec_slack_items i
           set source_class = public.exec_slack_item_source_class(c.conv_type, c.class, c.is_private, c.ext_ever,
                                                                  c.is_ext_shared, c.finance_name),
               updated_at = now()
          from public.exec_slack_channels c
         where c.principal_id = i.principal_id and c.channel_id = i.channel_id
           and i.principal_id = v_inst.principal_id and i.channel_id = p_channel
           and i.source_class <> public.exec_slack_item_source_class(c.conv_type, c.class, c.is_private, c.ext_ever,
                                                                     c.is_ext_shared, c.finance_name);
      end if;
      v_outcome := 'external';
    elsif v_lc = 'unshared' then
      if coalesce((p_ingest ->> 'is_ext_shared')::boolean, false) or v_ch.class = 'deny' then
        v_outcome := 'still_shared';
      else
        update public.exec_slack_channels set is_ext_shared = false, updated_at = now()
         where principal_id = v_inst.principal_id and channel_id = p_channel;
        v_outcome := 'classify';
      end if;
    elsif v_lc = 'id_changed' then
      if p_ingest ->> 'new_channel' is null then raise exception 'exec_slack_accept_event_v2: new_channel required'; end if;
      insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
      values ('exec.slack-rekey', 'interactive', v_inst.principal_id,
              jsonb_build_object('installation_id', v_inst.id, 'old_channel', p_channel, 'new_channel', p_ingest ->> 'new_channel'),
              'slack-rekey:' || v_inst.principal_id || ':' || p_channel || ':' || (p_ingest ->> 'new_channel'), 3)
      on conflict (dedupe_key) do nothing;
      v_outcome := 'rekey';
    end if;
    if v_outcome = 'classify' then
      insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
      values ('exec.slack-classify', 'bulk', v_inst.principal_id,
              jsonb_build_object('installation_id', v_inst.id, 'channel', p_channel),
              'slack-classify:' || v_inst.principal_id || ':' || p_channel || ':e' || p_event_id, 3)
      on conflict (dedupe_key) do nothing;
    end if;
    update public.exec_slack_events set ingest_outcome = v_outcome where event_id = p_event_id;
    return jsonb_build_object('outcome', 'accepted', 'decision', 'lifecycle', 'reason', v_outcome, 'recorded', true,
                              'enqueued', v_outcome in ('classify', 'rekey'), 'interactive', v_outcome = 'rekey', 'path', 'v2');
  end if;

  -- 6. New messages (and edits of messages DD doesn't hold) need discovery done (N2), the switch on (N20) and the
  --    conversation's type granted (C26). Deletes (4b) and stored-row edits (4c) never reach this step.
  if v_inst.discovered_at is null then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'discovering', 'recorded', false, 'path', 'v2');
  end if;
  if not coalesce((select s.slack_reading_enabled from public.exec_settings s where s.principal_id = v_inst.principal_id), false) then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'reading_off', 'recorded', false, 'path', 'v2');
  end if;
  v_scope := case v_conv when 'channel' then 'channels:history' when 'group' then 'groups:history'
                         when 'im' then 'im:history' when 'mpim' then 'mpim:history' end;
  if v_scope is null or not (v_scope = any (v_inst.user_scopes)) then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'scope', 'recorded', false, 'path', 'v2');
  end if;

  -- 7. Classes (N1, N2, C5): unknown -> an id-only row and a classify job; deny / unclassified -> dropped, nothing written.
  if not v_have then
    insert into public.exec_slack_channels (principal_id, installation_id, channel_id, conv_type, is_private)
    values (v_inst.principal_id, v_inst.id, p_channel, v_conv, v_conv <> 'channel') on conflict do nothing;
  end if;
  if not v_have or v_ch.class = 'unclassified' then
    insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
    values ('exec.slack-classify', case when v_conv in ('im', 'mpim') then 'interactive' else 'bulk' end, v_inst.principal_id,
            jsonb_build_object('installation_id', v_inst.id, 'channel', p_channel),
            'slack-classify:' || v_inst.principal_id || ':' || p_channel || ':h' || v_hour::text, 3)
    on conflict (dedupe_key) do nothing;
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'unclassified', 'recorded', false,
                              'enqueued', true, 'interactive', v_conv in ('im', 'mpim'), 'path', 'v2');
  end if;
  if v_ch.class = 'deny' then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'deny', 'recorded', false, 'path', 'v2');
  end if;

  select * into v_dd from public.exec_slack_dd_bot d where d.team_id = p_team_id and d.ok;
  v_is_dd := coalesce((p_ingest ->> 'dd_template')::boolean, false)
             or (v_dd.app_id is not null and p_ingest ->> 'app_id' = v_dd.app_id)
             or (v_dd.user_id is not null and v_author = v_dd.user_id);
  v_is_dd := coalesce(v_is_dd, false);

  -- 8. (Deletes are handled in 4b, before every gate: C43.)

  -- 9. Hubs keep DD posts as anchors and nothing else (N1, N3, C35).
  if v_ch.class = 'hub' then
    if v_kind = 'msg' and v_is_dd and v_ch.watch_state = 'watched' then
      if not public.exec_slack_record_event(p_event_id, v_inst.id, v_inst.principal_id, p_team_id, p_api_app_id, p_event_type,
                                            'ingest', 'anchor', v_time, v_retry, null) then
        return jsonb_build_object('outcome', 'duplicate', 'path', 'v2');
      end if;
      perform public.exec_slack_note_messages(v_inst.principal_id, p_channel,
                jsonb_build_array(jsonb_build_object('ts', v_ts, 'thread_ts', v_thread, 'role', 'anchor', 'author', null,
                                                     'author_external', false, 'reasons', 0,
                                                     'dd_paths', v_paths)), 'bulk', 'm0');
      return jsonb_build_object('outcome', 'accepted', 'decision', 'ingest', 'reason', 'anchor', 'recorded', true, 'path', 'v2');
    end if;
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'hub', 'recorded', false, 'path', 'v2');
  end if;
  if v_ch.watch_state = 'unwatched' or v_ch.left_at is not null then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'unwatched', 'recorded', false, 'path', 'v2');
  end if;

  -- 10. DD posts elsewhere: anchors only, never triaged, never his answer (N3, N9).
  if v_is_dd then
    if v_kind <> 'msg' then
      return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'dd_post', 'recorded', false, 'path', 'v2');
    end if;
    if not public.exec_slack_record_event(p_event_id, v_inst.id, v_inst.principal_id, p_team_id, p_api_app_id, p_event_type,
                                          'ingest', 'anchor', v_time, v_retry, null) then
      return jsonb_build_object('outcome', 'duplicate', 'path', 'v2');
    end if;
    perform public.exec_slack_note_messages(v_inst.principal_id, p_channel,
              jsonb_build_array(jsonb_build_object('ts', v_ts, 'thread_ts', v_thread, 'role', 'anchor', 'author', null,
                                                   'author_external', false, 'reasons', 0,
                                                   'dd_paths', v_paths)), 'bulk', 'm0');
    return jsonb_build_object('outcome', 'accepted', 'decision', 'ingest', 'reason', 'anchor', 'recorded', true, 'path', 'v2');
  end if;

  -- 11. Bots: none is triaged (the allow-list ships empty). A null flag counts as a bot (fail closed).
  if coalesce((p_ingest ->> 'is_bot')::boolean, true) then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'bot', 'recorded', false, 'path', 'v2');
  end if;

  -- 12. A deleted ts is never written again (N7).
  if exists (select 1 from public.exec_slack_deleted d where d.principal_id = v_inst.principal_id
              and d.channel_id = p_channel and d.ts = v_ts) then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'deleted', 'recorded', false, 'path', 'v2');
  end if;

  -- 13. (Edits of stored rows are handled in 4c, before every gate: C22, C43. An edit reaching here is of a message
  --     DD doesn't hold and is treated as a new message.)

  update public.exec_slack_channels set last_event_ts = v_ts, updated_at = now()
   where principal_id = v_inst.principal_id and channel_id = p_channel
     and (last_event_ts is null or last_event_ts::numeric < v_ts::numeric);

  -- 14. From him: participation and "answered" (N9). DD posts as him never reach here (step 10).
  if v_author = v_inst.user_id then
    if not public.exec_slack_record_event(p_event_id, v_inst.id, v_inst.principal_id, p_team_id, p_api_app_id, p_event_type,
                                          'ingest', 'from_him', v_time, v_retry, v_inst.user_id) then
      return jsonb_build_object('outcome', 'duplicate', 'path', 'v2');
    end if;
    v_res := public.exec_slack_note_from_him(v_inst.principal_id, p_channel,
               jsonb_build_array(jsonb_build_object('ts', v_ts, 'thread_ts', v_thread,
                                                    'mentions', coalesce(p_ingest -> 'mentions', '[]'::jsonb))));
    return jsonb_build_object('outcome', 'accepted', 'decision', 'ingest', 'reason', 'from_him', 'recorded', true, 'path', 'v2') || v_res;
  end if;

  -- 15. Candidates (N8, C11): DMs, explicit mentions, replies in his threads.
  v_len := coalesce((p_ingest ->> 'len')::integer, 0);
  v_mentions := array(select jsonb_array_elements_text(coalesce(p_ingest -> 'mentions', '[]'::jsonb)));
  if v_conv = 'im' and v_len >= 1 then
    v_reasons := v_reasons | 1;
  elsif v_conv = 'mpim' and v_len >= 1
        and (v_inst.user_id = any (v_mentions) or coalesce((p_ingest ->> 'question')::boolean, false) or v_len >= 2) then
    v_reasons := v_reasons | 1;
  end if;
  if v_inst.user_id = any (v_mentions) then v_reasons := v_reasons | 2; end if;
  if v_thread is not null and (p_ingest ->> 'parent_user' = v_inst.user_id or exists (
        select 1 from public.exec_slack_threads t where t.principal_id = v_inst.principal_id and t.channel_id = p_channel
           and t.thread_ts = v_thread and t.he_posted_ts is not null)) then
    v_reasons := v_reasons | 4;
  end if;
  if v_reasons = 0 then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'not_addressed', 'recorded', false, 'path', 'v2');
  end if;
  -- N11: only DMs and explicit mentions bypass a mute, and only the owner's or Slack's mute. N1's finance default mute
  -- (mute_source 'default_finance') is never bypassed: nothing there is a candidate until the owner watches it. A muted
  -- finance channel (class finance or a finance name, C10) is never bypassed, whatever the stored source.
  if v_ch.watch_state = 'muted' and (v_ch.mute_source = 'default_finance' or v_ch.class = 'finance' or v_ch.finance_name
                                     or (v_reasons & 3) = 0) then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'muted', 'recorded', false, 'path', 'v2');
  end if;
  -- C44: an author whose messages were deleted on request is never ingested again.
  if v_author is not null and exists (select 1 from public.exec_slack_author_optouts o
                                       where o.principal_id = v_inst.principal_id and o.author_user_id = v_author) then
    return jsonb_build_object('outcome', 'accepted', 'decision', 'drop', 'reason', 'opted_out', 'recorded', false, 'path', 'v2');
  end if;
  -- C33 (N10, fail closed): another team, or no team at all in a conversation that is or was shared, is external.
  v_ext := (p_ingest ->> 'author_team' is not null and p_ingest ->> 'author_team' <> v_inst.team_id)
           or (p_ingest ->> 'author_team' is null and (v_ch.class = 'external' or v_ch.ext_ever or v_ch.is_ext_shared));
  if not public.exec_slack_record_event(p_event_id, v_inst.id, v_inst.principal_id, p_team_id, p_api_app_id, p_event_type,
                                        'ingest', 'candidate', v_time, v_retry, null) then
    return jsonb_build_object('outcome', 'duplicate', 'path', 'v2');
  end if;
  v_res := public.exec_slack_note_messages(v_inst.principal_id, p_channel,
             jsonb_build_array(jsonb_build_object(
               'ts', v_ts, 'thread_ts', v_thread, 'role', 'candidate', 'author', v_author, 'reasons', v_reasons,
               'author_external', v_ext, 'dd_paths', v_paths)),
             'interactive', 'm' || floor(extract(epoch from v_now) / 60)::bigint::text);
  return jsonb_build_object('outcome', 'accepted', 'decision', 'ingest', 'reason', 'candidate', 'recorded', true,
                            'enqueued', coalesce((v_res ->> 'jobs')::integer, 0) > 0,
                            'interactive', coalesce((v_res ->> 'jobs')::integer, 0) > 0, 'path', 'v2');
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. exec_slack_write_items (the triage writer; the only excerpt writer; the other half of the race)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_write_items(text, text, jsonb, jsonb);
create or replace function public.exec_slack_write_items(p_principal text, p_channel text, p_rows jsonb, p_outcomes jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ch               public.exec_slack_channels%rowtype;
  v_class            text;
  v_ext_conv         boolean;
  v_days             integer;
  o                  jsonb;
  v_m                public.exec_slack_messages%rowtype;
  v_n                integer;
  v_written          integer := 0;
  v_refused_deleted  integer := 0;
  v_refused_missing  integer := 0;
  v_refused_optout   integer := 0;
  v_refused_closed   integer := 0;
  v_mismatch         integer := 0;
  v_closed           boolean;
begin
  if p_channel is null or p_channel !~ '^[CGD][A-Z0-9]{2,30}$' then raise exception 'exec_slack_write_items: bad channel'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_typeof(p_outcomes) <> 'array'
     or jsonb_array_length(p_rows) > 200 or jsonb_array_length(p_outcomes) > 100 then
    raise exception 'exec_slack_write_items: rows and outcomes must be arrays (<= 200 / <= 100)';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where not exists (select 1 from jsonb_array_elements(p_outcomes) x where x ->> 'ts' = e ->> 'ts')) then
    raise exception 'exec_slack_write_items: an item without an outcome';
  end if;
  -- C50: the channel row first (FOR SHARE: class changes and purges wait for us, and we for them), then message rows.
  select * into v_ch from public.exec_slack_channels c
   where c.principal_id = p_principal and c.channel_id = p_channel for share;
  if not found or v_ch.class in ('deny', 'unclassified', 'hub') then
    return jsonb_build_object('written', 0, 'refused_deleted', 0, 'refused_missing', 0, 'refused_optout', 0,
                              'class_mismatch', 0, 'refused_class', jsonb_array_length(p_outcomes));
  end if;
  -- C45: the conversation's one source_class, from the locked row. The caller's value is only compared (a twin check).
  v_class := public.exec_slack_item_source_class(v_ch.conv_type, v_ch.class, v_ch.is_private, v_ch.ext_ever,
                                                  v_ch.is_ext_shared, v_ch.finance_name);
  select count(*) into v_mismatch from jsonb_array_elements(p_rows) e where e ->> 'source_class' is distinct from v_class;
  -- N10/C33 defence in depth: in a conversation that is or was shared, an excerpt needs a verified internal author.
  v_ext_conv := v_ch.class = 'external' or v_ch.ext_ever or v_ch.is_ext_shared;
  -- N1 / N12 defence in depth (from the locked row): "Don't watch", N1's finance default mute, or any mute on a finance
  -- channel (class finance or a finance name, C10) means nothing there becomes an item. Each outcome is recorded as
  -- skipped (counted in refused_class) and the stored items stay as they are (nothing is purged on a mute, N11).
  v_closed := v_ch.watch_state = 'unwatched'
              or (v_ch.watch_state = 'muted' and (v_ch.mute_source = 'default_finance' or v_ch.class = 'finance' or v_ch.finance_name));
  select coalesce(s.retention_days_slack, 90) into v_days from public.exec_settings s where s.principal_id = p_principal;
  v_days := coalesce(v_days, 90);
  for o in select value from jsonb_array_elements(p_outcomes) loop
    if o ->> 'ts' is null or o ->> 'ts' !~ '^[0-9]{1,12}\.[0-9]{1,8}$'
       or o ->> 'state' is null or o ->> 'state' not in ('assessed', 'unassessed', 'refused', 'failed', 'skipped')
       or (o ->> 'content_hash' is not null and o ->> 'content_hash' !~ '^[0-9a-f]{64}$') then
      raise exception 'exec_slack_write_items: bad outcome';
    end if;
    -- 1. Lock the message row. Missing (deleted, purged, expired) -> nothing is written.
    select * into v_m from public.exec_slack_messages
     where principal_id = p_principal and channel_id = p_channel and ts = o ->> 'ts' for update;
    if not found or v_m.role = 'anchor' then v_refused_missing := v_refused_missing + 1; continue; end if;
    -- 2. Under the lock, the marker: a delete committed before we locked is visible now.
    if exists (select 1 from public.exec_slack_deleted d where d.principal_id = p_principal
                and d.channel_id = p_channel and d.ts = o ->> 'ts') then
      v_refused_deleted := v_refused_deleted + 1; continue;
    end if;
    -- 2b. C44: an author whose messages were deleted on request never gets an item again.
    if v_m.author_user_id is not null and exists (select 1 from public.exec_slack_author_optouts x
                                                   where x.principal_id = p_principal and x.author_user_id = v_m.author_user_id) then
      v_refused_optout := v_refused_optout + 1; continue;
    end if;
    -- 2c. Unwatched, or a closed finance mute: no item, the outcome as skipped, the stored items kept.
    if v_closed then
      update public.exec_slack_messages set triage_state = 'skipped', assessed_at = now(), updated_at = now()
       where principal_id = p_principal and channel_id = p_channel and ts = o ->> 'ts';
      v_refused_closed := v_refused_closed + 1; continue;
    end if;
    -- 3. Replace this message's items; "answered" and "acknowledged" come from the locked row. External (fail closed):
    --    the caller's flag, the stored candidate's flag, or no verified internal author in a shared conversation.
    --    source_class is the conversation's (v_class); bypass_mute is never set in a default_finance-muted channel or a
    --    finance channel (C10: only a confirmed Watch opens one).
    delete from public.exec_slack_items where principal_id = p_principal and channel_id = p_channel and ts = o ->> 'ts';
    insert into public.exec_slack_items (principal_id, channel_id, ts, kind, thread_ts, author_user_id, author_label,
      author_external, assessed, addressed_to_you, needs_response, bypass_mute, urgency, summary, excerpt, due_text, due_at,
      commitment_direction, source_class, responded_ts, responded_at, acknowledged_at, expires_at)
    select p_principal, p_channel, x.ts, x.kind, v_m.thread_ts, x.author, x.author_label,
           y.ext, x.assessed, coalesce(x.addressed, false), coalesce(x.needs_response, false),
           coalesce(x.bypass_mute, false) and v_ch.mute_source is distinct from 'default_finance'
             and v_ch.class <> 'finance' and not v_ch.finance_name,
           coalesce(x.urgency, 'normal'), x.summary, case when y.ext then null else x.excerpt end, x.due_text, x.due_at,
           x.direction, v_class, v_m.responded_ts, v_m.responded_at, v_m.acknowledged_at,
           to_timestamp(x.ts::numeric) + make_interval(days => v_days)
      from jsonb_to_recordset(coalesce((select jsonb_agg(e) from jsonb_array_elements(p_rows) e where e ->> 'ts' = o ->> 'ts'),
                                       '[]'::jsonb))
           as x(ts text, kind text, author text, author_label text, author_external boolean, author_internal_verified boolean,
                assessed boolean, addressed boolean, needs_response boolean, bypass_mute boolean, urgency text, summary text,
                excerpt text, due_text text, due_at timestamptz, direction text, source_class text)
      cross join lateral (select coalesce(x.author_external, false) or v_m.author_external
                                 or (v_ext_conv and not coalesce(x.author_internal_verified, false)) as ext) y;
    get diagnostics v_n = row_count;
    v_written := v_written + v_n;
    update public.exec_slack_messages
       set role = case when v_n > 0 then 'item' else 'candidate' end, triage_state = o ->> 'state',
           content_hash = coalesce(o ->> 'content_hash', content_hash), assessed_at = now(), updated_at = now(),
           expires_at = to_timestamp(ts::numeric) + make_interval(days => v_days)
     where principal_id = p_principal and channel_id = p_channel and ts = o ->> 'ts';
  end loop;
  if v_written > 0 then perform public.exec_slack_kick_attention(p_principal); end if;
  return jsonb_build_object('written', v_written, 'refused_deleted', v_refused_deleted, 'refused_missing', v_refused_missing,
                            'refused_optout', v_refused_optout, 'class_mismatch', v_mismatch, 'refused_class', v_refused_closed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12, 13. exec_slack_apply_classes and exec_slack_finish_discovery (N1, N2, C9, C26, C34, C45)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_apply_classes(text, text, jsonb, timestamptz);
create or replace function public.exec_slack_apply_classes(p_principal text, p_installation_id text, p_rows jsonb,
                                                           p_run_started_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inst    public.exec_slack_installations%rowtype;
  r         jsonb;
  v_old     public.exec_slack_channels%rowtype;
  v_have    boolean;
  v_class   text;
  v_watch   text;
  v_mute    text;
  v_owner   timestamptz;
  v_fin     boolean;
  v_into_fin boolean;
  v_ts      text;
  v_n       integer;
  v_upserts integer := 0;
  v_denied  integer := 0;
  v_purged  integer := 0;
  v_hub_purged integer := 0;
  v_reclassed  integer := 0;
begin
  select * into v_inst from public.exec_slack_installations where id = p_installation_id;
  if not found or v_inst.principal_id <> p_principal or v_inst.revoked_at is not null or v_inst.user_token_enc is null then
    raise exception 'exec_slack_apply_classes: the installation is not reading';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'exec_slack_apply_classes: rows'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_class := r ->> 'class';
    if r ->> 'channel_id' is null or r ->> 'channel_id' !~ '^[CGD][A-Z0-9]{2,30}$'
       or r ->> 'conv_type' is null or r ->> 'conv_type' not in ('channel', 'group', 'im', 'mpim')
       or v_class is null or v_class not in ('unclassified', 'deny', 'hub', 'finance', 'external', 'standard')
       or coalesce(r ->> 'default_watch', 'unwatched') not in ('watched', 'muted', 'unwatched')
       or (r ->> 'default_mute' is not null and r ->> 'default_mute' not in ('default_finance', 'slack'))
       or (r -> 'finance_name' is not null and jsonb_typeof(r -> 'finance_name') not in ('boolean', 'null')) then
      raise exception 'exec_slack_apply_classes: bad row';
    end if;
    -- C45: class finance always carries the flag; an external named channel carries it when the classifier says so.
    v_fin := v_class = 'finance'
             or (v_class = 'external' and r ->> 'conv_type' in ('channel', 'group') and coalesce((r ->> 'finance_name')::boolean, false));
    select * into v_old from public.exec_slack_channels
     where principal_id = p_principal and channel_id = r ->> 'channel_id' for update;
    v_have := found;
    -- A row an earlier (revoked) installation left: its data goes before this one adopts the id.
    if v_have and v_old.installation_id <> p_installation_id then
      perform public.exec_slack_purge_conversation(p_principal, v_old.channel_id, 'reinstall');
      v_purged := v_purged + 1;
    end if;
    if v_class = 'deny' then
      if v_have and v_old.class <> 'deny' then
        perform public.exec_slack_purge_conversation(p_principal, v_old.channel_id, 'deny');
        v_purged := v_purged + 1;
      elsif v_have then
        -- Defence in depth (deny -> deny, N1 rule 7): anything a write that raced the earlier deny left behind goes now. No
        -- item can exist there (the writer refuses deny), so no purge-log row: nothing downstream ever used it.
        delete from public.exec_slack_messages where principal_id = p_principal and channel_id = v_old.channel_id;
        delete from public.exec_slack_threads where principal_id = p_principal and channel_id = v_old.channel_id;
        delete from public.exec_attention_items
         where principal_id = p_principal and source = 'slack' and starts_with(fingerprint, 'slack:msg:' || v_old.channel_id || ':');
      end if;
      insert into public.exec_slack_channels (principal_id, installation_id, channel_id, conv_type, class, deny_reason,
                                              watch_state, is_member, is_private, seen_at, classified_at)
      values (p_principal, p_installation_id, r ->> 'channel_id', r ->> 'conv_type', 'deny', r ->> 'deny_reason',
              'unwatched', false, true, p_run_started_at, now())
      on conflict (principal_id, channel_id) do update
        set installation_id = excluded.installation_id, conv_type = excluded.conv_type, class = 'deny',
            deny_reason = excluded.deny_reason, hub_kind = null, finance_name = false, watch_state = 'unwatched', mute_source = null,
            watch_set_by_owner_at = null, name = null, im_user_id = null, is_member = false, is_private = true,
            is_ext_shared = false, hist_watermark_ts = null, deep_swept_at = null, swept_at = null, last_event_ts = null,
            last_activity_ts = null, activity_30d = null, probed_at = null, left_at = null,
            seen_at = excluded.seen_at, classified_at = now(), updated_at = now();
      v_denied := v_denied + 1;
      continue;
    end if;
    -- The watch state: the owner's choice survives a re-classification (never into deny, never for a hub, and never
    -- INTO finance: C10's confirmation is not skipped); otherwise the classifier's default. His Slack mutes apply only
    -- at the first classification (C34).
    v_owner := null;
    v_into_fin := v_fin and not (v_have and v_old.finance_name);
    if v_class = 'unclassified' then
      v_watch := 'unwatched'; v_mute := null;
    elsif v_class = 'hub' then
      v_watch := case when coalesce((r ->> 'is_member')::boolean, false) then 'watched' else 'unwatched' end; v_mute := null;
    elsif v_have and v_old.watch_set_by_owner_at is not null and v_old.class not in ('deny', 'unclassified', 'hub')
          and v_old.installation_id = p_installation_id and not v_into_fin then
      v_watch := v_old.watch_state; v_mute := v_old.mute_source; v_owner := v_old.watch_set_by_owner_at;
    elsif r ->> 'default_mute' = 'slack' and v_have and v_old.class not in ('deny', 'unclassified')
          and v_old.installation_id = p_installation_id and not v_into_fin then
      v_watch := v_old.watch_state; v_mute := v_old.mute_source;
    else
      v_watch := coalesce(r ->> 'default_watch', 'unwatched');
      v_mute := case when v_watch = 'muted' then coalesce(r ->> 'default_mute', 'owner') end;
    end if;
    insert into public.exec_slack_channels (principal_id, installation_id, channel_id, conv_type, class, hub_kind, finance_name,
      watch_state, mute_source, watch_set_by_owner_at, name, im_user_id, is_member, is_private, is_ext_shared, ext_ever,
      is_archived, seen_at, classified_at)
    values (p_principal, p_installation_id, r ->> 'channel_id', r ->> 'conv_type', v_class, r ->> 'hub_kind', v_fin, v_watch,
            v_mute, v_owner, case when v_class = 'unclassified' then null else r ->> 'name' end, r ->> 'im_user_id',
            coalesce((r ->> 'is_member')::boolean, false),
            coalesce((r ->> 'is_private')::boolean, true) or r ->> 'conv_type' <> 'channel',
            coalesce((r ->> 'is_ext_shared')::boolean, false), coalesce((r ->> 'is_ext_shared')::boolean, false),
            coalesce((r ->> 'is_archived')::boolean, false), p_run_started_at, now())
    on conflict (principal_id, channel_id) do update
      set installation_id = excluded.installation_id, conv_type = excluded.conv_type, class = excluded.class,
          deny_reason = null, hub_kind = excluded.hub_kind, finance_name = excluded.finance_name, watch_state = excluded.watch_state,
          mute_source = excluded.mute_source, watch_set_by_owner_at = excluded.watch_set_by_owner_at,
          name = excluded.name, im_user_id = excluded.im_user_id, is_member = excluded.is_member,
          is_private = excluded.is_private, is_ext_shared = excluded.is_ext_shared,
          ext_ever = public.exec_slack_channels.ext_ever or excluded.is_ext_shared,
          is_archived = excluded.is_archived, left_at = case when excluded.is_member then null else public.exec_slack_channels.left_at end,
          seen_at = excluded.seen_at, classified_at = now(), updated_at = now();
    v_upserts := v_upserts + 1;
    if v_class = 'hub' then
      -- C45/C35: a hub keeps DD anchors only. Anything stored before it became a hub goes now, one purge-log row per ts
      -- (P7b digests and P8 briefs follow them, N15/M9).
      for v_ts in select m.ts from public.exec_slack_messages m
                   where m.principal_id = p_principal and m.channel_id = r ->> 'channel_id' and m.role <> 'anchor'
                   order by m.ts for update
      loop
        delete from public.exec_slack_items where principal_id = p_principal and channel_id = r ->> 'channel_id' and ts = v_ts;
        delete from public.exec_slack_messages where principal_id = p_principal and channel_id = r ->> 'channel_id' and ts = v_ts;
        delete from public.exec_attention_items
         where principal_id = p_principal and source = 'slack' and fingerprint = 'slack:msg:' || (r ->> 'channel_id') || ':' || v_ts;
        insert into public.exec_slack_purge_log (principal_id, scope, channel_id, ts, reason)
        values (p_principal, 'message', r ->> 'channel_id', v_ts, 'hub');
        v_hub_purged := v_hub_purged + 1;
      end loop;
    elsif v_class <> 'unclassified' then
      -- C45: every stored item re-derived from the row just written (a share missed by events, a public-to-private
      -- conversion, a rename into a finance name).
      update public.exec_slack_items i
         set source_class = public.exec_slack_item_source_class(c.conv_type, c.class, c.is_private, c.ext_ever,
                                                                c.is_ext_shared, c.finance_name),
             updated_at = now()
        from public.exec_slack_channels c
       where c.principal_id = i.principal_id and c.channel_id = i.channel_id
         and i.principal_id = p_principal and i.channel_id = r ->> 'channel_id'
         and i.source_class <> public.exec_slack_item_source_class(c.conv_type, c.class, c.is_private, c.ext_ever,
                                                                   c.is_ext_shared, c.finance_name);
      get diagnostics v_n = row_count;
      v_reclassed := v_reclassed + v_n;
    end if;
  end loop;
  if v_hub_purged > 0 then perform public.exec_slack_kick_attention(p_principal); end if;
  return jsonb_build_object('upserted', v_upserts, 'denied', v_denied, 'purged', v_purged, 'hub_purged', v_hub_purged,
                            'reclassed', v_reclassed);
end;
$$;

drop function if exists public.exec_slack_finish_discovery(text, text, timestamptz);
create or replace function public.exec_slack_finish_discovery(p_principal text, p_installation_id text, p_run_started_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inst    public.exec_slack_installations%rowtype;
  v_id      text;
  v_class   text;
  v_removed integer := 0;
begin
  select * into v_inst from public.exec_slack_installations where id = p_installation_id for update;
  if not found or v_inst.principal_id <> p_principal or v_inst.revoked_at is not null or v_inst.user_token_enc is null then
    return jsonb_build_object('ready', false, 'removed', 0);
  end if;
  -- Conversations a COMPLETE listing no longer returned (left, deleted, access lost), and types no longer granted (C26).
  -- Called only after every listing page of every granted type returned; a partial listing never removes anything.
  for v_id, v_class in
    select c.channel_id, c.class from public.exec_slack_channels c
     where c.principal_id = p_principal and c.installation_id = p_installation_id
       and (coalesce(c.seen_at, c.created_at) < p_run_started_at
            or (c.conv_type = 'channel' and not ('channels:history' = any (v_inst.user_scopes)))
            or (c.conv_type = 'group'   and not ('groups:history'   = any (v_inst.user_scopes)))
            or (c.conv_type = 'im'      and not ('im:history'       = any (v_inst.user_scopes)))
            or (c.conv_type = 'mpim'    and not ('mpim:history'     = any (v_inst.user_scopes))))
     order by c.channel_id
     for update
  loop
    -- N1, rule 7: a deny marker holds nothing to purge and is never named in the purge log; it simply goes.
    if v_class <> 'deny' then perform public.exec_slack_purge_conversation(p_principal, v_id, 'gone'); end if;
    delete from public.exec_slack_channels where principal_id = p_principal and channel_id = v_id;
    v_removed := v_removed + 1;
  end loop;
  update public.exec_slack_installations
     set reading_state = 'ready', discovered_at = coalesce(discovered_at, now()), updated_at = now()
   where id = p_installation_id;
  return jsonb_build_object('ready', true, 'removed', v_removed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 14, 15. exec_slack_purge_reading and exec_slack_user_revoke (N4, N13; C25, C42)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_purge_reading(text);
create or replace function public.exec_slack_purge_reading(p_installation_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inst     public.exec_slack_installations%rowtype;
  v_channels integer;
  v_attn     integer;
  v_events   integer;
begin
  select * into v_inst from public.exec_slack_installations where id = p_installation_id for update;
  if not found then return jsonb_build_object('purged', false); end if;
  if v_inst.revoked_at is null and v_inst.user_revoked_at is null then
    raise exception 'exec_slack_purge_reading: the reading half is live';
  end if;
  -- Channels of THIS installation; their threads, messages and items cascade. A reconnect's newer rows stay.
  delete from public.exec_slack_channels where installation_id = p_installation_id;
  get diagnostics v_channels = row_count;
  -- Slack attention rows no message row backs any more (this purge's, and any older orphan of the principal).
  delete from public.exec_attention_items a
   where a.principal_id = v_inst.principal_id and a.source = 'slack' and starts_with(a.fingerprint, 'slack:msg:')
     and not exists (select 1 from public.exec_slack_messages m
                      where m.principal_id = a.principal_id and a.fingerprint = 'slack:msg:' || m.channel_id || ':' || m.ts);
  get diagnostics v_attn = row_count;
  delete from public.exec_slack_events where installation_id = p_installation_id and decision in ('ingest', 'lifecycle');
  get diagnostics v_events = row_count;
  update public.exec_slack_installations
     set user_token_enc = null, user_key_id = null,
         user_revoked_at = case when reading_state = 'none' then user_revoked_at else coalesce(user_revoked_at, now()) end,
         user_revoke_reason = case when reading_state = 'none' then user_revoke_reason
                                   else coalesce(user_revoke_reason, 'installation_revoked') end,
         reading_state = case when reading_state = 'none' then 'none' else 'revoked' end,
         discovered_at = null, reading_purged_at = now(), updated_at = now()
   where id = p_installation_id;
  insert into public.exec_slack_purge_log (principal_id, scope, reason) values (v_inst.principal_id, 'reading', 'reading_purged');
  return jsonb_build_object('purged', true, 'channels', v_channels, 'attention', v_attn, 'events', v_events);
end;
$$;

drop function if exists public.exec_slack_user_revoke(text, text);
create or replace function public.exec_slack_user_revoke(p_installation_id text, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revoked boolean;
  v_purge   jsonb := null;
begin
  if p_reason is null or p_reason not in ('stopped', 'tokens_revoked', 'disconnected', 'app_uninstalled') then
    raise exception 'exec_slack_user_revoke: bad reason';
  end if;
  update public.exec_slack_installations
     set user_revoked_at = now(), user_revoke_reason = p_reason, user_token_enc = null, user_key_id = null,
         reading_state = 'revoked', discovered_at = null, updated_at = now()
   where id = p_installation_id and reading_state in ('discovering', 'ready');
  v_revoked := found;
  if v_revoked or exists (select 1 from public.exec_slack_installations
                           where id = p_installation_id and reading_state = 'revoked' and reading_purged_at is null) then
    v_purge := public.exec_slack_purge_reading(p_installation_id);
  end if;
  return jsonb_build_object('revoked', v_revoked, 'purge', v_purge);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16, 17. The limiter (N6; C13): per (team, method), a one-minute window with priority classes. P6 and P8 calls are
--         unmetered and keep the rest of Tier 3's 50.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_rate_take(text, text, text, integer, timestamptz);
create or replace function public.exec_slack_rate_take(p_team text, p_method text, p_class text, p_n integer, p_now timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now    timestamptz := coalesce(p_now, now());
  v_window timestamptz := date_trunc('minute', coalesce(p_now, now()));
  v_row    public.exec_slack_rate%rowtype;
  v_tier   text;
  v_own    integer;
  v_ok     boolean;
begin
  if p_class is null or p_class not in ('triage', 'sweep', 'probe', 'discovery') then raise exception 'exec_slack_rate_take: bad class'; end if;
  if p_n is null or p_n < 1 or p_n > 10 then raise exception 'exec_slack_rate_take: n must be 1..10'; end if;
  v_tier := case
    when p_method in ('conversations.history', 'conversations.replies', 'conversations.info', 'users.conversations') then 't3'
    when p_method in ('conversations.list', 'users.list') then 't2'
    when p_method = 'users.info' then 't4'
    when p_method = 'chat.getPermalink' then 'special' end;
  if v_tier is null or p_team is null or p_team !~ '^T[A-Z0-9]{2,30}$' then raise exception 'exec_slack_rate_take: bad team or method'; end if;
  insert into public.exec_slack_rate (team_id, method, window_start) values (p_team, p_method, v_window)
  on conflict (team_id, method) do nothing;
  select * into v_row from public.exec_slack_rate where team_id = p_team and method = p_method for update;
  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    return jsonb_build_object('allowed', false, 'reason', 'blocked',
                              'wait_ms', ceil(extract(epoch from (v_row.blocked_until - v_now)) * 1000)::integer);
  end if;
  if v_row.window_start <> v_window then
    v_row.n_total := 0; v_row.n_triage := 0; v_row.n_sweep := 0; v_row.n_probe := 0; v_row.n_discovery := 0;
  end if;
  v_own := case p_class when 'triage' then v_row.n_triage when 'sweep' then v_row.n_sweep
                        when 'probe' then v_row.n_probe else v_row.n_discovery end;
  -- Thresholds on the metered total AFTER the take.
  v_ok := case v_tier
    when 't3' then case p_class when 'triage' then v_row.n_total + p_n <= 40
                                when 'sweep'  then v_row.n_total + p_n <= 30
                                else v_row.n_total + p_n <= 20 and v_own + p_n <= 10 end
    when 't2' then p_class = 'discovery' and v_row.n_total + p_n <= 15
    when 't4' then v_row.n_total + p_n <= 60
    else v_row.n_total + p_n <= 100 end;
  update public.exec_slack_rate
     set window_start = v_window,
         n_total     = v_row.n_total     + case when v_ok then p_n else 0 end,
         n_triage    = v_row.n_triage    + case when v_ok and p_class = 'triage'    then p_n else 0 end,
         n_sweep     = v_row.n_sweep     + case when v_ok and p_class = 'sweep'     then p_n else 0 end,
         n_probe     = v_row.n_probe     + case when v_ok and p_class = 'probe'     then p_n else 0 end,
         n_discovery = v_row.n_discovery + case when v_ok and p_class = 'discovery' then p_n else 0 end,
         updated_at  = now()
   where team_id = p_team and method = p_method;
  if v_ok then return jsonb_build_object('allowed', true, 'wait_ms', 0); end if;
  return jsonb_build_object('allowed', false, 'reason', 'budget',
                            'wait_ms', ceil(extract(epoch from (v_window + interval '1 minute' - v_now)) * 1000)::integer);
end;
$$;

drop function if exists public.exec_slack_rate_block(text, text, timestamptz);
create or replace function public.exec_slack_rate_block(p_team text, p_method text, p_until timestamptz)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_until timestamptz := least(coalesce(p_until, now() + interval '30 seconds'), now() + interval '10 minutes');
begin
  insert into public.exec_slack_rate (team_id, method, window_start, blocked_until)
  values (p_team, p_method, date_trunc('minute', now()), v_until)
  on conflict (team_id, method) do update
    set blocked_until = greatest(coalesce(public.exec_slack_rate.blocked_until, v_until), v_until), updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 18. exec_slack_rekey_channel (N10: channel_id_changed). ON UPDATE CASCADE moves threads, messages and items.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_rekey_channel(text, text, text);
create or replace function public.exec_slack_rekey_channel(p_principal text, p_old text, p_new text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old       public.exec_slack_channels%rowtype;
  v_new_class text;
  v_n         integer;
begin
  if p_old is null or p_new is null or p_old !~ '^[CGD][A-Z0-9]{2,30}$' or p_new !~ '^[CGD][A-Z0-9]{2,30}$' then
    raise exception 'exec_slack_rekey_channel: bad ids';
  end if;
  if p_old = p_new then return jsonb_build_object('rekeyed', false, 'attention', 0); end if;
  select * into v_old from public.exec_slack_channels where principal_id = p_principal and channel_id = p_old for update;
  if not found then return jsonb_build_object('rekeyed', false, 'attention', 0); end if;
  select c.class into v_new_class from public.exec_slack_channels c where c.principal_id = p_principal and c.channel_id = p_new for update;
  -- N1, rule 7: a deny marker on the new id wins (only the classifier turns deny into anything else). The old row's data
  -- goes (the conversation is now known to be one that is never read) and its row with it; the marker stays as it is.
  if v_new_class = 'deny' then
    if v_old.class <> 'deny' then perform public.exec_slack_purge_conversation(p_principal, p_old, 'deny'); end if;
    delete from public.exec_slack_channels where principal_id = p_principal and channel_id = p_old;
    return jsonb_build_object('rekeyed', false, 'attention', 0);
  end if;
  -- A placeholder the new id got from events in the meantime gives way to the old row.
  if v_new_class is not null then
    perform public.exec_slack_purge_conversation(p_principal, p_new, 'rekey');
    delete from public.exec_slack_channels where principal_id = p_principal and channel_id = p_new;
  end if;
  update public.exec_slack_channels set channel_id = p_new, updated_at = now()
   where principal_id = p_principal and channel_id = p_old;
  update public.exec_slack_deleted d set channel_id = p_new
   where d.principal_id = p_principal and d.channel_id = p_old
     and not exists (select 1 from public.exec_slack_deleted x where x.principal_id = p_principal and x.channel_id = p_new and x.ts = d.ts);
  update public.exec_slack_items set permalink = null, updated_at = now() where principal_id = p_principal and channel_id = p_new;
  -- G21: the attention rows keep their snooze/dismiss state under the new fingerprint.
  update public.exec_attention_items
     set fingerprint = 'slack:msg:' || p_new || ':' || substring(fingerprint from char_length('slack:msg:' || p_old || ':') + 1)
   where principal_id = p_principal and source = 'slack' and starts_with(fingerprint, 'slack:msg:' || p_old || ':');
  get diagnostics v_n = row_count;
  if v_n > 0 then perform public.exec_slack_kick_attention(p_principal); end if;
  return jsonb_build_object('rekeyed', true, 'attention', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- 19. exec_slack_purge_expired (N13 TTL; principal-agnostic so P8 M10 can move it to the system purge unchanged)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_purge_expired(timestamptz);
create or replace function public.exec_slack_purge_expired(p_now timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_items    integer;
  v_msgs     integer;
  v_threads  integer;
  v_markers  integer;
  v_log      integer;
  v_channels integer;
  v_attn     integer;
begin
  delete from public.exec_slack_items where ctid in (select ctid from public.exec_slack_items where expires_at < v_now limit 5000);
  get diagnostics v_items = row_count;
  delete from public.exec_slack_messages where ctid in (select ctid from public.exec_slack_messages where expires_at < v_now limit 5000);
  get diagnostics v_msgs = row_count;
  delete from public.exec_slack_threads where ctid in (select ctid from public.exec_slack_threads where expires_at < v_now limit 5000);
  get diagnostics v_threads = row_count;
  delete from public.exec_slack_deleted where expires_at < v_now;
  get diagnostics v_markers = row_count;
  delete from public.exec_slack_purge_log where expires_at < v_now;
  get diagnostics v_log = row_count;
  delete from public.exec_slack_channels where left_at is not null and left_at < v_now - interval '30 days';
  get diagnostics v_channels = row_count;
  -- Orphans: Slack message items whose message row is gone (expired above, or by any earlier path).
  delete from public.exec_attention_items a
   where a.source = 'slack' and starts_with(a.fingerprint, 'slack:msg:')
     and not exists (select 1 from public.exec_slack_messages m
                      where m.principal_id = a.principal_id and a.fingerprint = 'slack:msg:' || m.channel_id || ':' || m.ts);
  get diagnostics v_attn = row_count;
  return jsonb_build_object('items', v_items, 'messages', v_msgs, 'threads', v_threads, 'markers', v_markers,
                            'log', v_log, 'channels', v_channels, 'attention', v_attn);
end;
$$;

-- ---------------------------------------------------------------------------
-- 20. exec_slack_set_watch (the picker; N11, N12, C10)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_set_watch(text, text, text, timestamptz, boolean);
create or replace function public.exec_slack_set_watch(p_principal text, p_channel text, p_watch text,
                                                       p_expected timestamptz, p_allow_finance boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v public.exec_slack_channels%rowtype;
  v_at timestamptz;
begin
  if p_watch is null or p_watch not in ('watched', 'muted', 'unwatched') then raise exception 'exec_slack_set_watch: bad state'; end if;
  select * into v from public.exec_slack_channels where principal_id = p_principal and channel_id = p_channel for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v.class in ('deny', 'unclassified', 'hub') then return jsonb_build_object('outcome', 'refused', 'class', v.class); end if;
  if v.left_at is not null and v.conv_type <> 'channel' then return jsonb_build_object('outcome', 'refused', 'class', 'left'); end if;
  if p_expected is null or v.updated_at <> p_expected then
    return jsonb_build_object('outcome', 'conflict', 'updated_at', v.updated_at);
  end if;
  -- C10: a finance channel, or a Slack Connect channel with a finance name, needs the explicit confirmation.
  if p_watch = 'watched' and (v.class = 'finance' or v.finance_name) and v.watch_state <> 'watched'
     and not coalesce(p_allow_finance, false) then
    return jsonb_build_object('outcome', 'confirmation_required');
  end if;
  -- C10, N1, N11: a mute on a finance channel (class finance, or a finance-named Slack Connect channel) is the closed
  -- finance mute, never an owner mute a DM or a mention could bypass: "Don't watch" then "Mute" can't skip the
  -- confirmation. Only a confirmed Watch opens a finance channel.
  update public.exec_slack_channels
     set watch_state = p_watch,
         mute_source = case when p_watch <> 'muted' then null
                            when v.class = 'finance' or v.finance_name then 'default_finance'
                            else 'owner' end,
         watch_set_by_owner_at = now(), updated_at = now()
   where principal_id = p_principal and channel_id = p_channel
  returning updated_at into v_at;
  return jsonb_build_object('outcome', 'updated', 'updated_at', v_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 24. exec_slack_purge_author (C44: a person's deletion request; Slack's Developer Policy). The runbook's only step.
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_purge_author(text, text);
create or replace function public.exec_slack_purge_author(p_principal text, p_author text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ch    text;
  v_ts    text;
  v_n     integer;
  v_items integer := 0;
  v_msgs  integer := 0;
  v_attn  integer := 0;
  v_convs integer := 0;
begin
  if p_principal is null or not exists (select 1 from public.exec_principals p where p.id = p_principal) then
    raise exception 'exec_slack_purge_author: unknown principal';
  end if;
  if p_author is null or p_author !~ '^[UW][A-Z0-9]{2,30}$' then raise exception 'exec_slack_purge_author: bad author'; end if;
  -- 1. The opt-out first: from this commit on, v2 step 15, exec_slack_note_messages and exec_slack_write_items refuse
  --    the author, so no sweep, edit, reply or retried triage job brings their words back.
  insert into public.exec_slack_author_optouts (principal_id, author_user_id) values (p_principal, p_author)
  on conflict (principal_id, author_user_id) do nothing;
  -- 2. Every IM with that person, whole (one 'conversation' purge-log row each).
  for v_ch in select c.channel_id from public.exec_slack_channels c
               where c.principal_id = p_principal and c.conv_type = 'im' and c.im_user_id = p_author
               order by c.channel_id
  loop
    perform public.exec_slack_purge_conversation(p_principal, v_ch, 'author_optout');
    v_convs := v_convs + 1;
  end loop;
  -- 3. Their stored messages, and every stored row of a thread rooted at or containing one of them (other people's
  --    summaries in that thread may describe their words). Channel row, then message row (C50); one 'message'
  --    purge-log row per ts, so P7b (digests, chat, N15) and P8 (briefs, M9) follow.
  for v_ch, v_ts in
    select m.channel_id, m.ts from public.exec_slack_messages m
     where m.principal_id = p_principal and m.role <> 'anchor'
       and exists (select 1 from public.exec_slack_messages a
                    where a.principal_id = m.principal_id and a.channel_id = m.channel_id and a.author_user_id = p_author
                      and (a.ts = m.ts
                           or (a.thread_ts is not null and coalesce(m.thread_ts, m.ts) = a.thread_ts)
                           or m.thread_ts = a.ts))
     order by m.channel_id, m.ts
  loop
    perform 1 from public.exec_slack_channels where principal_id = p_principal and channel_id = v_ch for update;
    perform 1 from public.exec_slack_messages where principal_id = p_principal and channel_id = v_ch and ts = v_ts for update;
    delete from public.exec_slack_items where principal_id = p_principal and channel_id = v_ch and ts = v_ts;
    get diagnostics v_n = row_count; v_items := v_items + v_n;
    delete from public.exec_slack_messages where principal_id = p_principal and channel_id = v_ch and ts = v_ts;
    get diagnostics v_n = row_count; v_msgs := v_msgs + v_n;
    delete from public.exec_attention_items
     where principal_id = p_principal and source = 'slack' and fingerprint = 'slack:msg:' || v_ch || ':' || v_ts;
    get diagnostics v_n = row_count; v_attn := v_attn + v_n;
    insert into public.exec_slack_purge_log (principal_id, scope, channel_id, ts, reason)
    values (p_principal, 'message', v_ch, v_ts, 'author_optout');
  end loop;
  if v_items + v_attn + v_convs > 0 then perform public.exec_slack_kick_attention(p_principal); end if;
  return jsonb_build_object('conversations', v_convs, 'messages', v_msgs, 'items', v_items, 'attention', v_attn, 'opted_out', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on with no policies; nothing for anon/authenticated; service_role only.
-- (The new columns of exec_settings, exec_slack_installations, exec_slack_events and exec_oauth_states inherit their
-- tables' grants.)
-- ---------------------------------------------------------------------------

alter table public.exec_slack_channels       enable row level security;
alter table public.exec_slack_threads        enable row level security;
alter table public.exec_slack_messages       enable row level security;
alter table public.exec_slack_items          enable row level security;
alter table public.exec_slack_deleted        enable row level security;
alter table public.exec_slack_rate           enable row level security;
alter table public.exec_slack_dd_bot         enable row level security;
alter table public.exec_slack_purge_log      enable row level security;
alter table public.exec_slack_author_optouts enable row level security;
revoke all on public.exec_slack_channels, public.exec_slack_threads, public.exec_slack_messages, public.exec_slack_items,
  public.exec_slack_deleted, public.exec_slack_rate, public.exec_slack_dd_bot, public.exec_slack_purge_log,
  public.exec_slack_author_optouts
  from public, anon, authenticated;
grant all on public.exec_slack_channels, public.exec_slack_threads, public.exec_slack_messages, public.exec_slack_items,
  public.exec_slack_deleted, public.exec_slack_rate, public.exec_slack_dd_bot, public.exec_slack_purge_log,
  public.exec_slack_author_optouts to service_role;
do $$
declare s text;
begin
  s := pg_get_serial_sequence('public.exec_slack_purge_log', 'id');
  execute format('revoke all on sequence %s from public, anon, authenticated', s);
  execute format('grant usage, select on sequence %s to service_role', s);
end $$;

revoke all on function public.exec_slack_ingest_check(jsonb) from public, anon, authenticated;
revoke all on function public.exec_slack_lead_name(text) from public, anon, authenticated;
revoke all on function public.exec_slack_fb_lead_channels() from public, anon, authenticated;
revoke all on function public.exec_slack_kick_attention(text) from public, anon, authenticated;
revoke all on function public.exec_slack_record_event(text, text, text, text, text, text, text, text, timestamptz, integer, text)
  from public, anon, authenticated;
revoke all on function public.exec_slack_note_messages(text, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_note_from_him(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.exec_slack_save_thread_watermark(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_mark_deleted(text, text, text[], text) from public, anon, authenticated;
revoke all on function public.exec_slack_purge_conversation(text, text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_accept_event_v2(text, text, text, text, bigint, integer, text, text, text, text, text,
  boolean, boolean, text, boolean, boolean, boolean, text, text[], text[], jsonb) from public, anon, authenticated;
revoke all on function public.exec_slack_write_items(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.exec_slack_apply_classes(text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_finish_discovery(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_purge_reading(text) from public, anon, authenticated;
revoke all on function public.exec_slack_user_revoke(text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_rate_take(text, text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_rate_block(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_rekey_channel(text, text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_purge_expired(timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_set_watch(text, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.exec_slack_finance_name(text) from public, anon, authenticated;
revoke all on function public.exec_slack_item_source_class(text, text, boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.exec_slack_dd_paths_ok(text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_purge_author(text, text) from public, anon, authenticated;
grant execute on function public.exec_slack_ingest_check(jsonb) to service_role;
grant execute on function public.exec_slack_lead_name(text) to service_role;
grant execute on function public.exec_slack_fb_lead_channels() to service_role;
grant execute on function public.exec_slack_kick_attention(text) to service_role;
grant execute on function public.exec_slack_record_event(text, text, text, text, text, text, text, text, timestamptz, integer, text)
  to service_role;
grant execute on function public.exec_slack_note_messages(text, text, jsonb, text, text) to service_role;
grant execute on function public.exec_slack_note_from_him(text, text, jsonb) to service_role;
grant execute on function public.exec_slack_save_thread_watermark(text, text, text, text, text) to service_role;
grant execute on function public.exec_slack_mark_deleted(text, text, text[], text) to service_role;
grant execute on function public.exec_slack_purge_conversation(text, text, text) to service_role;
grant execute on function public.exec_slack_accept_event_v2(text, text, text, text, bigint, integer, text, text, text, text, text,
  boolean, boolean, text, boolean, boolean, boolean, text, text[], text[], jsonb) to service_role;
grant execute on function public.exec_slack_write_items(text, text, jsonb, jsonb) to service_role;
grant execute on function public.exec_slack_apply_classes(text, text, jsonb, timestamptz) to service_role;
grant execute on function public.exec_slack_finish_discovery(text, text, timestamptz) to service_role;
grant execute on function public.exec_slack_purge_reading(text) to service_role;
grant execute on function public.exec_slack_user_revoke(text, text) to service_role;
grant execute on function public.exec_slack_rate_take(text, text, text, integer, timestamptz) to service_role;
grant execute on function public.exec_slack_rate_block(text, text, timestamptz) to service_role;
grant execute on function public.exec_slack_rekey_channel(text, text, text) to service_role;
grant execute on function public.exec_slack_purge_expired(timestamptz) to service_role;
grant execute on function public.exec_slack_set_watch(text, text, text, timestamptz, boolean) to service_role;
grant execute on function public.exec_slack_finance_name(text) to service_role;
grant execute on function public.exec_slack_item_source_class(text, text, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.exec_slack_dd_paths_ok(text[]) to service_role;
grant execute on function public.exec_slack_purge_author(text, text) to service_role;

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
--   * every column of the nine new tables with type and nullability, the new
--     columns of exec_settings / exec_slack_installations / exec_slack_events /
--     exec_oauth_states, the defaults the app relies on (watch_mode now
--     'member_only'), and exec_slack_purge_log.id an identity;
--   * the text rule (no text outside exec_slack_items' four text columns and
--     the channel name; dd_paths the one text[] column, checked by
--     exec_slack_dd_paths_ok);
--   * every named CHECK (several by the words their definition must hold),
--     incl. the three P6 constraints redefined above with their NEW bodies;
--   * the primary keys, the unique item key, and the foreign keys with BOTH
--     their ON UPDATE and ON DELETE actions;
--   * every index by its definition (the text after " USING ") and uniqueness;
--   * the twenty-five functions: SECURITY INVOKER with search_path pinned, one
--     signature each; v2's argument names in order (PostgREST binds them by
--     name, C48); P6's v1 ack still present with its 20-parameter signature;
--   * what this file relies on from P6 and P2b.
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
    ('columns: exec_slack_channels', 'exec_slack_channels'), ('columns: exec_slack_threads', 'exec_slack_threads'),
    ('columns: exec_slack_messages', 'exec_slack_messages'), ('columns: exec_slack_items', 'exec_slack_items'),
    ('columns: exec_slack_deleted', 'exec_slack_deleted'), ('columns: exec_slack_rate', 'exec_slack_rate'),
    ('columns: exec_slack_dd_bot', 'exec_slack_dd_bot'), ('columns: exec_slack_purge_log', 'exec_slack_purge_log'),
    ('columns: exec_slack_author_optouts', 'exec_slack_author_optouts'),
    ('columns (P7a): exec_settings', 'exec_settings'), ('columns (P7a): exec_slack_installations', 'exec_slack_installations'),
    ('columns (P7a): exec_slack_events', 'exec_slack_events'), ('columns (P7a): exec_oauth_states', 'exec_oauth_states')
  ) e(label, tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_slack_channels', 1, 'principal_id', 'text', true),
      ('exec_slack_channels', 2, 'installation_id', 'text', true),
      ('exec_slack_channels', 3, 'channel_id', 'text', true),
      ('exec_slack_channels', 4, 'conv_type', 'text', true),
      ('exec_slack_channels', 5, 'class', 'text', true),
      ('exec_slack_channels', 6, 'deny_reason', 'text', false),
      ('exec_slack_channels', 7, 'hub_kind', 'text', false),
      ('exec_slack_channels', 8, 'finance_name', 'boolean', true),
      ('exec_slack_channels', 9, 'watch_state', 'text', true),
      ('exec_slack_channels', 10, 'mute_source', 'text', false),
      ('exec_slack_channels', 11, 'watch_set_by_owner_at', 'timestamp with time zone', false),
      ('exec_slack_channels', 12, 'name', 'text', false),
      ('exec_slack_channels', 13, 'im_user_id', 'text', false),
      ('exec_slack_channels', 14, 'is_member', 'boolean', true),
      ('exec_slack_channels', 15, 'is_private', 'boolean', true),
      ('exec_slack_channels', 16, 'is_ext_shared', 'boolean', true),
      ('exec_slack_channels', 17, 'ext_ever', 'boolean', true),
      ('exec_slack_channels', 18, 'is_archived', 'boolean', true),
      ('exec_slack_channels', 19, 'hist_watermark_ts', 'text', false),
      ('exec_slack_channels', 20, 'deep_swept_at', 'timestamp with time zone', false),
      ('exec_slack_channels', 21, 'swept_at', 'timestamp with time zone', false),
      ('exec_slack_channels', 22, 'last_event_ts', 'text', false),
      ('exec_slack_channels', 23, 'last_activity_ts', 'text', false),
      ('exec_slack_channels', 24, 'activity_30d', 'integer', false),
      ('exec_slack_channels', 25, 'probed_at', 'timestamp with time zone', false),
      ('exec_slack_channels', 26, 'classified_at', 'timestamp with time zone', false),
      ('exec_slack_channels', 27, 'seen_at', 'timestamp with time zone', false),
      ('exec_slack_channels', 28, 'left_at', 'timestamp with time zone', false),
      ('exec_slack_channels', 29, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_channels', 30, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_threads', 1, 'principal_id', 'text', true),
      ('exec_slack_threads', 2, 'channel_id', 'text', true),
      ('exec_slack_threads', 3, 'thread_ts', 'text', true),
      ('exec_slack_threads', 4, 'he_posted_ts', 'text', false),
      ('exec_slack_threads', 5, 'reply_watermark_ts', 'text', false),
      ('exec_slack_threads', 6, 'latest_reply_seen_ts', 'text', false),
      ('exec_slack_threads', 7, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_threads', 8, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_messages', 1, 'principal_id', 'text', true),
      ('exec_slack_messages', 2, 'channel_id', 'text', true),
      ('exec_slack_messages', 3, 'ts', 'text', true),
      ('exec_slack_messages', 4, 'thread_ts', 'text', false),
      ('exec_slack_messages', 5, 'role', 'text', true),
      ('exec_slack_messages', 6, 'author_user_id', 'text', false),
      ('exec_slack_messages', 7, 'author_external', 'boolean', true),
      ('exec_slack_messages', 8, 'is_dd_post', 'boolean', true),
      ('exec_slack_messages', 9, 'dd_paths', 'text[]', true),
      ('exec_slack_messages', 10, 'reasons', 'smallint', true),
      ('exec_slack_messages', 11, 'triage_state', 'text', true),
      ('exec_slack_messages', 12, 'content_hash', 'text', false),
      ('exec_slack_messages', 13, 'edited_ts', 'text', false),
      ('exec_slack_messages', 14, 'responded_ts', 'text', false),
      ('exec_slack_messages', 15, 'responded_at', 'timestamp with time zone', false),
      ('exec_slack_messages', 16, 'acknowledged_at', 'timestamp with time zone', false),
      ('exec_slack_messages', 17, 'assessed_at', 'timestamp with time zone', false),
      ('exec_slack_messages', 18, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_messages', 19, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_messages', 20, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_items', 1, 'id', 'text', true),
      ('exec_slack_items', 2, 'principal_id', 'text', true),
      ('exec_slack_items', 3, 'channel_id', 'text', true),
      ('exec_slack_items', 4, 'ts', 'text', true),
      ('exec_slack_items', 5, 'kind', 'text', true),
      ('exec_slack_items', 6, 'thread_ts', 'text', false),
      ('exec_slack_items', 7, 'author_user_id', 'text', false),
      ('exec_slack_items', 8, 'author_label', 'text', false),
      ('exec_slack_items', 9, 'author_external', 'boolean', true),
      ('exec_slack_items', 10, 'assessed', 'boolean', true),
      ('exec_slack_items', 11, 'addressed_to_you', 'boolean', true),
      ('exec_slack_items', 12, 'needs_response', 'boolean', true),
      ('exec_slack_items', 13, 'bypass_mute', 'boolean', true),
      ('exec_slack_items', 14, 'urgency', 'text', true),
      ('exec_slack_items', 15, 'summary', 'text', false),
      ('exec_slack_items', 16, 'excerpt', 'text', false),
      ('exec_slack_items', 17, 'due_text', 'text', false),
      ('exec_slack_items', 18, 'due_at', 'timestamp with time zone', false),
      ('exec_slack_items', 19, 'commitment_direction', 'text', false),
      ('exec_slack_items', 20, 'source_class', 'text', true),
      ('exec_slack_items', 21, 'permalink', 'text', false),
      ('exec_slack_items', 22, 'responded_ts', 'text', false),
      ('exec_slack_items', 23, 'responded_at', 'timestamp with time zone', false),
      ('exec_slack_items', 24, 'acknowledged_at', 'timestamp with time zone', false),
      ('exec_slack_items', 25, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_items', 26, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_items', 27, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_deleted', 1, 'principal_id', 'text', true),
      ('exec_slack_deleted', 2, 'channel_id', 'text', true),
      ('exec_slack_deleted', 3, 'ts', 'text', true),
      ('exec_slack_deleted', 4, 'reason', 'text', true),
      ('exec_slack_deleted', 5, 'deleted_at', 'timestamp with time zone', true),
      ('exec_slack_deleted', 6, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_rate', 1, 'team_id', 'text', true),
      ('exec_slack_rate', 2, 'method', 'text', true),
      ('exec_slack_rate', 3, 'window_start', 'timestamp with time zone', true),
      ('exec_slack_rate', 4, 'n_total', 'integer', true),
      ('exec_slack_rate', 5, 'n_triage', 'integer', true),
      ('exec_slack_rate', 6, 'n_sweep', 'integer', true),
      ('exec_slack_rate', 7, 'n_probe', 'integer', true),
      ('exec_slack_rate', 8, 'n_discovery', 'integer', true),
      ('exec_slack_rate', 9, 'blocked_until', 'timestamp with time zone', false),
      ('exec_slack_rate', 10, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_dd_bot', 1, 'team_id', 'text', true),
      ('exec_slack_dd_bot', 2, 'ok', 'boolean', true),
      ('exec_slack_dd_bot', 3, 'user_id', 'text', false),
      ('exec_slack_dd_bot', 4, 'bot_id', 'text', false),
      ('exec_slack_dd_bot', 5, 'app_id', 'text', false),
      ('exec_slack_dd_bot', 6, 'error_code', 'text', false),
      ('exec_slack_dd_bot', 7, 'checked_at', 'timestamp with time zone', true),
      ('exec_slack_purge_log', 1, 'id', 'bigint', true),
      ('exec_slack_purge_log', 2, 'principal_id', 'text', true),
      ('exec_slack_purge_log', 3, 'scope', 'text', true),
      ('exec_slack_purge_log', 4, 'channel_id', 'text', false),
      ('exec_slack_purge_log', 5, 'ts', 'text', false),
      ('exec_slack_purge_log', 6, 'reason', 'text', true),
      ('exec_slack_purge_log', 7, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_purge_log', 8, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_author_optouts', 1, 'principal_id', 'text', true),
      ('exec_slack_author_optouts', 2, 'author_user_id', 'text', true),
      ('exec_slack_author_optouts', 3, 'created_at', 'timestamp with time zone', true),
      ('exec_settings', 1, 'slack_reading_enabled', 'boolean', true),
      ('exec_settings', 2, 'slack_daily_cap_usd', 'numeric(10,2)', true),
      ('exec_slack_installations', 1, 'user_key_id', 'text', false),
      ('exec_slack_installations', 2, 'user_installed_at', 'timestamp with time zone', false),
      ('exec_slack_installations', 3, 'user_revoked_at', 'timestamp with time zone', false),
      ('exec_slack_installations', 4, 'user_revoke_reason', 'text', false),
      ('exec_slack_installations', 5, 'user_last_error_code', 'text', false),
      ('exec_slack_installations', 6, 'user_last_error_at', 'timestamp with time zone', false),
      ('exec_slack_installations', 7, 'reading_state', 'text', true),
      ('exec_slack_installations', 8, 'discovered_at', 'timestamp with time zone', false),
      ('exec_slack_installations', 9, 'reading_purged_at', 'timestamp with time zone', false),
      ('exec_slack_events', 1, 'ingest_outcome', 'text', false),
      ('exec_oauth_states', 1, 'purpose', 'text', true)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select e.label, x.wrong is null, x.wrong
  from (values
    ('defaults: exec_slack_channels', 'exec_slack_channels'), ('defaults: exec_slack_threads', 'exec_slack_threads'),
    ('defaults: exec_slack_messages', 'exec_slack_messages'), ('defaults: exec_slack_items', 'exec_slack_items'),
    ('defaults: exec_slack_deleted', 'exec_slack_deleted'), ('defaults: exec_slack_rate', 'exec_slack_rate'),
    ('defaults: exec_slack_purge_log', 'exec_slack_purge_log'), ('defaults: exec_slack_author_optouts', 'exec_slack_author_optouts'),
    ('defaults (P7a): exec_settings', 'exec_settings'), ('defaults (P7a): exec_slack_installations', 'exec_slack_installations'),
    ('defaults (P7a): exec_oauth_states', 'exec_oauth_states')
  ) e(label, tbl)
  cross join lateral (
    select string_agg(k.col || ' default ' || k.def, ', ' order by k.col) as wrong
    from (values
      ('exec_slack_channels', 'class', '''unclassified''::text'),
      ('exec_slack_channels', 'finance_name', 'false'),
      ('exec_slack_channels', 'watch_state', '''unwatched''::text'),
      ('exec_slack_channels', 'is_member', 'false'),
      ('exec_slack_channels', 'is_private', 'true'),
      ('exec_slack_channels', 'is_ext_shared', 'false'),
      ('exec_slack_channels', 'ext_ever', 'false'),
      ('exec_slack_channels', 'is_archived', 'false'),
      ('exec_slack_channels', 'created_at', 'now()'),
      ('exec_slack_channels', 'updated_at', 'now()'),
      ('exec_slack_threads', 'updated_at', 'now()'),
      ('exec_slack_messages', 'author_external', 'false'),
      ('exec_slack_messages', 'is_dd_post', 'false'),
      ('exec_slack_messages', 'dd_paths', '''{}''::text[]'),
      ('exec_slack_messages', 'reasons', '0'),
      ('exec_slack_messages', 'triage_state', '''pending''::text'),
      ('exec_slack_messages', 'created_at', 'now()'),
      ('exec_slack_messages', 'updated_at', 'now()'),
      ('exec_slack_items', 'id', '(''esl_''::text || replace((gen_random_uuid())::text, ''-''::text, ''''::text))'),
      ('exec_slack_items', 'author_external', 'false'),
      ('exec_slack_items', 'addressed_to_you', 'false'),
      ('exec_slack_items', 'needs_response', 'false'),
      ('exec_slack_items', 'bypass_mute', 'false'),
      ('exec_slack_items', 'urgency', '''normal''::text'),
      ('exec_slack_items', 'created_at', 'now()'),
      ('exec_slack_items', 'updated_at', 'now()'),
      ('exec_slack_deleted', 'deleted_at', 'now()'),
      ('exec_slack_rate', 'n_total', '0'),
      ('exec_slack_rate', 'n_triage', '0'),
      ('exec_slack_rate', 'n_sweep', '0'),
      ('exec_slack_rate', 'n_probe', '0'),
      ('exec_slack_rate', 'n_discovery', '0'),
      ('exec_slack_rate', 'updated_at', 'now()'),
      ('exec_slack_purge_log', 'created_at', 'now()'),
      ('exec_slack_purge_log', 'expires_at', '(now() + ''7 days''::interval)'),
      ('exec_slack_author_optouts', 'created_at', 'now()'),
      ('exec_settings', 'slack_reading_enabled', 'false'),
      ('exec_settings', 'slack_daily_cap_usd', '2'),
      ('exec_settings', 'watch_mode', '''member_only''::text'),
      ('exec_slack_installations', 'reading_state', '''none''::text'),
      ('exec_oauth_states', 'purpose', '''install''::text')
    ) k(tbl, col, def)
    where k.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = k.col and not a.attisdropped
          and pg_get_expr(d.adbin, d.adrelid) = k.def)
  ) x
  union all
  select 'default (information_schema): exec_settings.watch_mode is ''member_only''', coalesce(x.def = '''member_only''::text', false),
         case when not coalesce(x.def = '''member_only''::text', false) then coalesce(x.def, '(no default)') end
  from (select 1) one
  left join lateral (
    select c.column_default::text as def from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'exec_settings' and c.column_name = 'watch_mode'
  ) x on true
  union all
  select 'identity: exec_slack_purge_log.id', coalesce(x.ident = 'a', false),
         case when not coalesce(x.ident = 'a', false) then coalesce('attidentity ' || nullif(x.ident, ''), '(not an identity)') end
  from (select 1) one
  left join lateral (
    select a.attidentity::text as ident from pg_attribute a
     where a.attrelid = to_regclass('public.exec_slack_purge_log') and a.attname = 'id' and not a.attisdropped
  ) x on true
  union all
  -- The text rule (§0.3 rule 5): among the nine tables and this file's columns of P2a/P6 tables, the only text columns
  -- whose names suggest content are the four of exec_slack_items and the channel name; no json at all.
  select 'text rule: text columns are exactly exec_slack_items.excerpt/summary/due_text/author_label and exec_slack_channels.name',
         x.found is not distinct from x.want, case when x.found is distinct from x.want then 'found: ' || coalesce(x.found, '(none)') end
  from (
    select (select string_agg(t.tbl || '.' || a.attname::text, ', ' order by t.tbl, a.attname::text)
              from (values ('exec_slack_channels'), ('exec_slack_threads'), ('exec_slack_messages'), ('exec_slack_items'),
                           ('exec_slack_deleted'), ('exec_slack_rate'), ('exec_slack_dd_bot'), ('exec_slack_purge_log'),
                           ('exec_slack_author_optouts')) t(tbl)
              join pg_attribute a on a.attrelid = to_regclass('public.' || t.tbl) and a.attnum > 0 and not a.attisdropped
             where (format_type(a.atttypid, a.atttypmod) in ('text', 'character varying', 'character', 'json', 'jsonb')
                    or format_type(a.atttypid, a.atttypmod) like 'character varying(%' or format_type(a.atttypid, a.atttypmod) like 'character(%')
               and (a.attname ~ '(excerpt|summary|text|body|subject|label|due_text|name)'
                    or format_type(a.atttypid, a.atttypmod) in ('json', 'jsonb'))
           ) as p7a_found,
           (select string_agg(p.tbl || '.' || p.col, ', ' order by p.tbl, p.col)
              from (values ('exec_settings', 'slack_reading_enabled'), ('exec_settings', 'slack_daily_cap_usd'),
                           ('exec_slack_installations', 'user_key_id'), ('exec_slack_installations', 'user_installed_at'),
                           ('exec_slack_installations', 'user_revoked_at'), ('exec_slack_installations', 'user_revoke_reason'),
                           ('exec_slack_installations', 'user_last_error_code'), ('exec_slack_installations', 'user_last_error_at'),
                           ('exec_slack_installations', 'reading_state'), ('exec_slack_installations', 'discovered_at'),
                           ('exec_slack_installations', 'reading_purged_at'), ('exec_slack_events', 'ingest_outcome'),
                           ('exec_oauth_states', 'purpose')) p(tbl, col)
              join pg_attribute a on a.attrelid = to_regclass('public.' || p.tbl) and a.attname = p.col and not a.attisdropped
             where format_type(a.atttypid, a.atttypmod) in ('text', 'character varying', 'character', 'json', 'jsonb')
               and (a.attname ~ '(excerpt|summary|text|body|subject|label|due_text|name)'
                    or format_type(a.atttypid, a.atttypmod) in ('json', 'jsonb'))
           ) as p6_found
  ) raw
  cross join lateral (
    select nullif(concat_ws(', ', raw.p7a_found, raw.p6_found), '') as found,
           'exec_slack_channels.name, exec_slack_items.author_label, exec_slack_items.due_text, exec_slack_items.excerpt, exec_slack_items.summary'::text as want
  ) x
  union all
  select 'text rule: the only array column is exec_slack_messages.dd_paths', x.found is not distinct from 'exec_slack_messages.dd_paths',
         case when x.found is distinct from 'exec_slack_messages.dd_paths' then 'found: ' || coalesce(x.found, '(none)') end
  from (
    select (select string_agg(t.tbl || '.' || a.attname::text, ', ' order by t.tbl, a.attname::text)
              from (values ('exec_slack_channels'), ('exec_slack_threads'), ('exec_slack_messages'), ('exec_slack_items'),
                           ('exec_slack_deleted'), ('exec_slack_rate'), ('exec_slack_dd_bot'), ('exec_slack_purge_log'),
                           ('exec_slack_author_optouts')) t(tbl)
              join pg_attribute a on a.attrelid = to_regclass('public.' || t.tbl) and a.attnum > 0 and not a.attisdropped
              join pg_type ty on ty.oid = a.atttypid
             where ty.typcategory = 'A') as found
  ) x
  union all
  select 'text rule: exec_slack_messages_dd_paths_check calls exec_slack_dd_paths_ok', coalesce(strpos(x.def, 'exec_slack_dd_paths_ok(dd_paths)') > 0, false),
         case when not coalesce(strpos(x.def, 'exec_slack_dd_paths_ok(dd_paths)') > 0, false) then coalesce(x.def, '(missing)') end
  from (select 1) one
  left join lateral (
    select pg_get_constraintdef(pc.oid) as def from pg_constraint pc
     where pc.conrelid = to_regclass('public.exec_slack_messages') and pc.conname = 'exec_slack_messages_dd_paths_check'
  ) x on true
  union all
  select e.label, x.missing is null, x.missing
  from (values
    ('checks: exec_slack_channels', 'exec_slack_channels'), ('checks: exec_slack_threads', 'exec_slack_threads'),
    ('checks: exec_slack_messages', 'exec_slack_messages'), ('checks: exec_slack_items', 'exec_slack_items'),
    ('checks: exec_slack_deleted', 'exec_slack_deleted'), ('checks: exec_slack_rate', 'exec_slack_rate'),
    ('checks: exec_slack_dd_bot', 'exec_slack_dd_bot'), ('checks: exec_slack_purge_log', 'exec_slack_purge_log'),
    ('checks: exec_slack_author_optouts', 'exec_slack_author_optouts'),
    ('checks (P7a): exec_settings', 'exec_settings'), ('checks (P7a): exec_slack_installations', 'exec_slack_installations'),
    ('checks (P7a): exec_slack_events', 'exec_slack_events'), ('checks (P7a): exec_oauth_states', 'exec_oauth_states')
  ) e(label, tbl)
  cross join lateral (
    select string_agg(k.name || case when d.def is null then '' else ' (definition)' end, ', ' order by k.name) as missing
    from (values
      ('exec_slack_channels', 'exec_slack_channels_id_check', null),
      ('exec_slack_channels', 'exec_slack_channels_type_check', array['channel', 'group', 'im', 'mpim']),
      ('exec_slack_channels', 'exec_slack_channels_class_check', array['unclassified', 'deny', 'hub', 'finance', 'external', 'standard']),
      ('exec_slack_channels', 'exec_slack_channels_reason_check',
       array['assistant_dm', 'dd_bot_dm', 'self_dm', 'bot_im', 'fb_list', 'lead_name']),
      ('exec_slack_channels', 'exec_slack_channels_hub_kind_check', array['outbound', 'client_email']),
      ('exec_slack_channels', 'exec_slack_channels_watch_check', array['watched', 'muted', 'unwatched']),
      ('exec_slack_channels', 'exec_slack_channels_mute_source_check', array['owner', 'default_finance', 'slack']),
      ('exec_slack_channels', 'exec_slack_channels_name_check', array['name']),
      ('exec_slack_channels', 'exec_slack_channels_im_user_check', null),
      ('exec_slack_channels', 'exec_slack_channels_wm_check', null),
      ('exec_slack_channels', 'exec_slack_channels_event_ts_check', null),
      ('exec_slack_channels', 'exec_slack_channels_activity_ts_check', null),
      ('exec_slack_channels', 'exec_slack_channels_activity_check', null),
      ('exec_slack_channels', 'exec_slack_channels_deny_check',
       array['deny_reason', 'name', 'im_user_id', 'watch_state', 'mute_source', 'watch_set_by_owner_at', 'is_ext_shared',
             'NOT finance_name', 'hist_watermark_ts', 'deep_swept_at', 'swept_at', 'last_event_ts', 'last_activity_ts',
             'activity_30d', 'probed_at']),
      ('exec_slack_channels', 'exec_slack_channels_reason_pair_check', array['class', 'deny_reason']),
      ('exec_slack_channels', 'exec_slack_channels_hub_pair_check', array['class', 'hub_kind']),
      ('exec_slack_channels', 'exec_slack_channels_unclassified_check', array['unclassified', 'watch_state', 'name', 'finance_name']),
      ('exec_slack_channels', 'exec_slack_channels_finance_name_check', array['finance', 'finance_name', 'conv_type', 'external']),
      ('exec_slack_channels', 'exec_slack_channels_mute_pair_check', array['watch_state', 'mute_source']),
      ('exec_slack_channels', 'exec_slack_channels_im_check', array['im_user_id', 'conv_type']),
      ('exec_slack_channels', 'exec_slack_channels_private_check', array['conv_type', 'is_private']),
      ('exec_slack_channels', 'exec_slack_channels_ext_ever_check', array['is_ext_shared', 'ext_ever']),
      ('exec_slack_channels', 'exec_slack_channels_external_check', array['is_ext_shared', 'standard', 'finance']),
      ('exec_slack_threads', 'exec_slack_threads_ts_check', null),
      ('exec_slack_threads', 'exec_slack_threads_he_check', null),
      ('exec_slack_threads', 'exec_slack_threads_wm_check', null),
      ('exec_slack_threads', 'exec_slack_threads_latest_check', null),
      ('exec_slack_messages', 'exec_slack_messages_ts_check', null),
      ('exec_slack_messages', 'exec_slack_messages_thread_check', array['thread_ts', 'ts']),
      ('exec_slack_messages', 'exec_slack_messages_role_check', array['candidate', 'item', 'anchor']),
      ('exec_slack_messages', 'exec_slack_messages_author_check', null),
      ('exec_slack_messages', 'exec_slack_messages_dd_paths_check', array['exec_slack_dd_paths_ok']),
      ('exec_slack_messages', 'exec_slack_messages_reasons_check', array['reasons', '0', '7']),
      ('exec_slack_messages', 'exec_slack_messages_state_check',
       array['pending', 'assessed', 'unassessed', 'refused', 'failed', 'skipped', 'none']),
      ('exec_slack_messages', 'exec_slack_messages_hash_check', null),
      ('exec_slack_messages', 'exec_slack_messages_edited_check', null),
      ('exec_slack_messages', 'exec_slack_messages_responded_check', null),
      ('exec_slack_messages', 'exec_slack_messages_anchor_check', array['role', 'anchor', 'is_dd_post']),
      ('exec_slack_messages', 'exec_slack_messages_anchor_state_check', array['reasons', 'triage_state', 'responded_ts', 'author_user_id']),
      ('exec_slack_messages', 'exec_slack_messages_candidate_state_check', array['triage_state', 'reasons']),
      ('exec_slack_messages', 'exec_slack_messages_responded_pair_check', array['responded_ts', 'responded_at']),
      ('exec_slack_items', 'exec_slack_items_kind_check', array['request', 'question', 'decision', 'commitment', 'action_item', 'fyi']),
      ('exec_slack_items', 'exec_slack_items_thread_check', null),
      ('exec_slack_items', 'exec_slack_items_author_check', null),
      ('exec_slack_items', 'exec_slack_items_label_check', array['author_label', '80']),
      ('exec_slack_items', 'exec_slack_items_urgency_check', array['critical', 'high', 'normal', 'low']),
      ('exec_slack_items', 'exec_slack_items_summary_check', array['summary', '200']),
      ('exec_slack_items', 'exec_slack_items_excerpt_check', array['excerpt', '280']),
      ('exec_slack_items', 'exec_slack_items_due_text_check', array['due_text', '60']),
      ('exec_slack_items', 'exec_slack_items_direction_check', array['mitchell_owes', 'owed_to_mitchell']),
      ('exec_slack_items', 'exec_slack_items_class_check', array['public', 'private', 'finance']),
      ('exec_slack_items', 'exec_slack_items_permalink_check', array['permalink', '500']),
      ('exec_slack_items', 'exec_slack_items_responded_check', null),
      ('exec_slack_items', 'exec_slack_items_external_check', array['author_external', 'excerpt']),
      ('exec_slack_items', 'exec_slack_items_commitment_check', array['kind', 'commitment_direction']),
      ('exec_slack_items', 'exec_slack_items_due_check', array['due_at', 'commitment']),
      ('exec_slack_items', 'exec_slack_items_unassessed_check', array['assessed', 'request', 'summary', 'excerpt', 'due_text']),
      ('exec_slack_items', 'exec_slack_items_responded_pair_check', array['responded_ts', 'responded_at']),
      ('exec_slack_deleted', 'exec_slack_deleted_channel_check', null),
      ('exec_slack_deleted', 'exec_slack_deleted_ts_check', null),
      ('exec_slack_deleted', 'exec_slack_deleted_reason_check', array['event', 'absent', 'tombstone']),
      ('exec_slack_deleted', 'exec_slack_deleted_ttl_check', array['expires_at', 'deleted_at', '25:00:00']),
      ('exec_slack_rate', 'exec_slack_rate_team_check', null),
      ('exec_slack_rate', 'exec_slack_rate_method_check',
       array['conversations.history', 'conversations.replies', 'conversations.info', 'users.conversations',
             'conversations.list', 'users.list', 'users.info', 'chat.getPermalink']),
      ('exec_slack_rate', 'exec_slack_rate_total_check', array['n_total', '1000']),
      ('exec_slack_rate', 'exec_slack_rate_sum_check', array['n_triage', 'n_sweep', 'n_probe', 'n_discovery', 'n_total']),
      ('exec_slack_dd_bot', 'exec_slack_dd_bot_team_check', null),
      ('exec_slack_dd_bot', 'exec_slack_dd_bot_user_check', null),
      ('exec_slack_dd_bot', 'exec_slack_dd_bot_bot_check', null),
      ('exec_slack_dd_bot', 'exec_slack_dd_bot_app_check', null),
      ('exec_slack_dd_bot', 'exec_slack_dd_bot_error_check', null),
      ('exec_slack_dd_bot', 'exec_slack_dd_bot_ok_check', array['ok', 'user_id', 'bot_id', 'error_code']),
      ('exec_slack_purge_log', 'exec_slack_purge_log_scope_check', array['message', 'conversation', 'reading']),
      ('exec_slack_purge_log', 'exec_slack_purge_log_channel_check', null),
      ('exec_slack_purge_log', 'exec_slack_purge_log_ts_check', null),
      ('exec_slack_purge_log', 'exec_slack_purge_log_reason_check', null),
      ('exec_slack_purge_log', 'exec_slack_purge_log_shape_check', array['scope', 'channel_id', 'ts']),
      ('exec_slack_author_optouts', 'exec_slack_author_optouts_author_check', array['author_user_id']),
      ('exec_settings', 'exec_settings_slack_cap_check', array['slack_daily_cap_usd', '100']),
      ('exec_slack_installations', 'exec_slack_installations_no_user_token', array['user_token_enc', '^v1']),
      ('exec_slack_installations', 'exec_slack_installations_no_user_scopes',
       array['user_scopes <@', 'channels:history', 'groups:history', 'channels:read', 'groups:read', 'users:read', 'im:history',
             'im:read', 'mpim:history', 'mpim:read']),
      ('exec_slack_installations', 'exec_slack_installations_user_key_check', array['user_key_id']),
      ('exec_slack_installations', 'exec_slack_installations_user_pair_check', array['user_token_enc', 'user_key_id']),
      ('exec_slack_installations', 'exec_slack_installations_user_live_check',
       array['user_token_enc', 'user_installed_at', 'user_revoked_at', 'user_scopes']),
      ('exec_slack_installations', 'exec_slack_installations_user_revoke_check',
       array['user_revoked_at', 'user_revoke_reason', 'stopped', 'tokens_revoked', 'disconnected', 'app_uninstalled', 'installation_revoked']),
      ('exec_slack_installations', 'exec_slack_installations_user_error_check', array['user_last_error_code', 'user_last_error_at']),
      ('exec_slack_installations', 'exec_slack_installations_reading_state_check',
       array['none', 'discovering', 'ready', 'revoked', 'user_token_enc', 'discovered_at']),
      ('exec_slack_events', 'exec_slack_events_decision_check', array['reply', 'home', 'revoke', 'revoke_check', 'drop', '''ingest''', 'lifecycle']),
      ('exec_slack_events', 'exec_slack_events_ingest_check', array['ingest_outcome', 'channel_id', 'message_ts', 'thread_ts', 'reply_state']),
      ('exec_oauth_states', 'exec_oauth_states_purpose_check', array['install', 'read'])
    ) k(tbl, name, needs)
    cross join lateral (
      select pg_get_constraintdef(pc.oid) as def
      from pg_constraint pc
      where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = k.name
      union all
      select null::text where not exists (select 1 from pg_constraint pc
                                           where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = k.name)
    ) d
    where k.tbl = e.tbl
      and (d.def is null
           or (k.needs is not null and exists (
                 select 1 from unnest(k.needs) w
                  where case when w ~ '^[A-Za-z0-9_:.]+$' then d.def !~ ('\m' || w || '\M') else strpos(d.def, w) = 0 end)))
  ) x
  union all
  select e.label, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('primary key: exec_slack_channels', 'exec_slack_channels', 'exec_slack_channels_pkey', 'p', array['principal_id', 'channel_id']),
    ('primary key: exec_slack_threads', 'exec_slack_threads', 'exec_slack_threads_pkey', 'p', array['principal_id', 'channel_id', 'thread_ts']),
    ('primary key: exec_slack_messages', 'exec_slack_messages', 'exec_slack_messages_pkey', 'p', array['principal_id', 'channel_id', 'ts']),
    ('primary key: exec_slack_items', 'exec_slack_items', 'exec_slack_items_pkey', 'p', array['id']),
    ('primary key: exec_slack_deleted', 'exec_slack_deleted', 'exec_slack_deleted_pkey', 'p', array['principal_id', 'channel_id', 'ts']),
    ('primary key: exec_slack_rate', 'exec_slack_rate', 'exec_slack_rate_pkey', 'p', array['team_id', 'method']),
    ('primary key: exec_slack_dd_bot', 'exec_slack_dd_bot', 'exec_slack_dd_bot_pkey', 'p', array['team_id']),
    ('primary key: exec_slack_purge_log', 'exec_slack_purge_log', 'exec_slack_purge_log_pkey', 'p', array['id']),
    ('primary key: exec_slack_author_optouts', 'exec_slack_author_optouts', 'exec_slack_author_optouts_pkey', 'p',
     array['principal_id', 'author_user_id']),
    ('unique: exec_slack_items_key (principal_id, channel_id, ts, kind)', 'exec_slack_items', 'exec_slack_items_key', 'u',
     array['principal_id', 'channel_id', 'ts', 'kind'])
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
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'f'
                   and k.confrelid = to_regclass('public.' || e.ref)
                   and k.confupdtype = case e.upd when 'cascade' then 'c' when 'no action' then 'a' end
                   and k.confdeltype = case e.del when 'cascade' then 'c' when 'set null' then 'n' end
                   and array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                             order by u.ord) = e.cols),
         null
  from (values
    ('exec_slack_channels', array['principal_id'], 'exec_principals', 'no action', 'cascade'),
    ('exec_slack_channels', array['installation_id'], 'exec_slack_installations', 'no action', 'cascade'),
    ('exec_slack_threads', array['principal_id', 'channel_id'], 'exec_slack_channels', 'cascade', 'cascade'),
    ('exec_slack_messages', array['principal_id', 'channel_id'], 'exec_slack_channels', 'cascade', 'cascade'),
    ('exec_slack_items', array['principal_id', 'channel_id', 'ts'], 'exec_slack_messages', 'cascade', 'cascade'),
    ('exec_slack_deleted', array['principal_id'], 'exec_principals', 'no action', 'cascade'),
    ('exec_slack_purge_log', array['principal_id'], 'exec_principals', 'no action', 'cascade'),
    ('exec_slack_author_optouts', array['principal_id'], 'exec_principals', 'no action', 'cascade')
  ) e(tbl, cols, ref, upd, del)
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def and x.uniq = e.uniq, false),
         case when not coalesce(x.def = e.def and x.uniq = e.uniq, false)
              then coalesce(case when x.uniq then 'unique ' else '' end || x.def, '(missing)') end
  from (values
    ('exec_slack_installations', 'exec_slack_installations_reading_key',
     'btree (team_id, app_id) WHERE ((revoked_at IS NULL) AND (user_token_enc IS NOT NULL))', true),
    ('exec_slack_installations', 'exec_slack_installations_revoked_reading_idx',
     'btree (id) WHERE ((reading_state = ''revoked''::text) AND (reading_purged_at IS NULL))', false),
    ('exec_slack_channels', 'exec_slack_channels_installation_idx', 'btree (installation_id)', false),
    ('exec_slack_channels', 'exec_slack_channels_sweep_idx',
     'btree (principal_id, swept_at NULLS FIRST) WHERE ((watch_state = ''watched''::text) OR ((watch_state = ''muted''::text) AND (mute_source = ANY (ARRAY[''owner''::text, ''slack''::text]))))', false),
    ('exec_slack_channels', 'exec_slack_channels_unclassified_idx', 'btree (principal_id) WHERE (class = ''unclassified''::text)', false),
    ('exec_slack_channels', 'exec_slack_channels_probe_idx',
     'btree (principal_id, probed_at NULLS FIRST) WHERE ((conv_type = ''channel''::text) AND (class = ANY (ARRAY[''standard''::text, ''external''::text])) AND (NOT is_member))', false),
    ('exec_slack_threads', 'exec_slack_threads_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_messages', 'exec_slack_messages_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_messages', 'exec_slack_messages_pending_idx',
     'btree (principal_id, channel_id, thread_ts) WHERE (triage_state = ''pending''::text)', false),
    ('exec_slack_messages', 'exec_slack_messages_thread_idx', 'btree (principal_id, channel_id, thread_ts) WHERE (thread_ts IS NOT NULL)', false),
    ('exec_slack_items', 'exec_slack_items_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_items', 'exec_slack_items_open_idx',
     'btree (principal_id, created_at DESC) WHERE ((responded_at IS NULL) AND (kind <> ''fyi''::text))', false),
    ('exec_slack_items', 'exec_slack_items_channel_idx', 'btree (principal_id, channel_id, ts)', false),
    ('exec_slack_items', 'exec_slack_items_key', 'btree (principal_id, channel_id, ts, kind)', true),
    ('exec_slack_deleted', 'exec_slack_deleted_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_purge_log', 'exec_slack_purge_log_principal_idx', 'btree (principal_id, id)', false),
    ('exec_slack_purge_log', 'exec_slack_purge_log_expires_idx', 'btree (expires_at)', false)
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
    ('exec_slack_ingest_check(jsonb)'),
    ('exec_slack_lead_name(text)'),
    ('exec_slack_fb_lead_channels()'),
    ('exec_slack_kick_attention(text)'),
    ('exec_slack_record_event(text,text,text,text,text,text,text,text,timestamptz,integer,text)'),
    ('exec_slack_note_messages(text,text,jsonb,text,text)'),
    ('exec_slack_note_from_him(text,text,jsonb)'),
    ('exec_slack_save_thread_watermark(text,text,text,text,text)'),
    ('exec_slack_mark_deleted(text,text,text[],text)'),
    ('exec_slack_purge_conversation(text,text,text)'),
    ('exec_slack_accept_event_v2(text,text,text,text,bigint,integer,text,text,text,text,text,boolean,boolean,text,boolean,boolean,boolean,text,text[],text[],jsonb)'),
    ('exec_slack_write_items(text,text,jsonb,jsonb)'),
    ('exec_slack_apply_classes(text,text,jsonb,timestamptz)'),
    ('exec_slack_finish_discovery(text,text,timestamptz)'),
    ('exec_slack_purge_reading(text)'),
    ('exec_slack_user_revoke(text,text)'),
    ('exec_slack_rate_take(text,text,text,integer,timestamptz)'),
    ('exec_slack_rate_block(text,text,timestamptz)'),
    ('exec_slack_rekey_channel(text,text,text)'),
    ('exec_slack_purge_expired(timestamptz)'),
    ('exec_slack_set_watch(text,text,text,timestamptz,boolean)'),
    ('exec_slack_finance_name(text)'),
    ('exec_slack_item_source_class(text,text,boolean,boolean,boolean,boolean)'),
    ('exec_slack_dd_paths_ok(text[])'),
    ('exec_slack_purge_author(text,text)')
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
  from (values ('exec_slack_ingest_check'), ('exec_slack_lead_name'), ('exec_slack_fb_lead_channels'), ('exec_slack_kick_attention'),
               ('exec_slack_record_event'), ('exec_slack_note_messages'), ('exec_slack_note_from_him'), ('exec_slack_save_thread_watermark'),
               ('exec_slack_mark_deleted'),
               ('exec_slack_purge_conversation'), ('exec_slack_accept_event_v2'), ('exec_slack_write_items'),
               ('exec_slack_apply_classes'), ('exec_slack_finish_discovery'), ('exec_slack_purge_reading'), ('exec_slack_user_revoke'),
               ('exec_slack_rate_take'), ('exec_slack_rate_block'), ('exec_slack_rekey_channel'), ('exec_slack_purge_expired'),
               ('exec_slack_set_watch'), ('exec_slack_finance_name'), ('exec_slack_item_source_class'), ('exec_slack_dd_paths_ok'),
               ('exec_slack_purge_author')) e(name)
  cross join lateral (
    select count(*)::int as n, string_agg(p.oid::regprocedure::text, '; ') as sigs
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = e.name
  ) x
  union all
  -- C48: PostgREST binds an RPC's arguments by NAME; a renamed parameter would make every reading event fall back to v1.
  select 'argument names: exec_slack_accept_event_v2 (p_event_id ... p_revoked_user_ids, p_ingest)', coalesce(x.args = e.want, false),
         case when not coalesce(x.args = e.want, false) then coalesce(x.args, '(missing)') end
  from (values ('p_event_id text, p_team_id text, p_api_app_id text, p_event_type text, p_event_time bigint, p_retry_num integer, '
                || 'p_channel text, p_channel_type text, p_user text, p_ts text, p_thread_ts text, p_has_bot_id boolean, '
                || 'p_has_app_id boolean, p_subtype text, p_hidden boolean, p_text_is_string boolean, p_has_message boolean, '
                || 'p_tab text, p_revoked_bot_ids text[], p_revoked_user_ids text[], p_ingest jsonb')) e(want)
  left join lateral (
    select pg_get_function_identity_arguments(p.oid) as args from pg_proc p
     where p.oid = to_regprocedure('public.exec_slack_accept_event_v2(text,text,text,text,bigint,integer,text,text,text,text,text,'
                                   || 'boolean,boolean,text,boolean,boolean,boolean,text,text[],text[],jsonb)')
  ) x on true
  union all
  select 'still present (P6): exec_slack_accept_event with its 20-parameter signature',
         to_regprocedure('public.exec_slack_accept_event(text,text,text,text,bigint,integer,text,text,text,text,text,'
                         || 'boolean,boolean,text,boolean,boolean,boolean,text,text[],text[])') is not null, null
  union all
  select 'relies on (P6): unique index exec_slack_installations_active_key', coalesce(x.uniq, false),
         case when not coalesce(x.uniq, false) then coalesce(case when x.uniq then 'unique' else 'not unique' end, '(missing)') end
  from (select 1) one
  left join lateral (
    select i.indisunique as uniq from pg_index i join pg_class ic on ic.oid = i.indexrelid
     where i.indrelid = to_regclass('public.exec_slack_installations') and ic.relname = 'exec_slack_installations_active_key'
  ) x on true
  union all
  select 'relies on (' || e.phase || '): check ' || e.name,
         exists (select 1 from pg_constraint k where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'c' and k.conname = e.name),
         null
  from (values ('P6', 'exec_slack_events', 'exec_slack_events_drop_check'),
               ('P2b', 'exec_attention_items', 'exec_attention_items_fingerprint_check')) e(phase, tbl, name)
) checks
order by ok, check_name;
