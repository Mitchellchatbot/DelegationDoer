-- Executive AI Assistant — P10: read every conversation he is in (a settings switch; the classifier change is in code),
-- lead counts (counts only), Slack reply drafts in his tone (posted as him only on his click).
--
--   exec_settings               + slack_read_all, slack_lead_counts_enabled, slack_replies_enabled, slack_reply_send_enabled,
--                                 slack_reply_auto (all default false), slack_reply_daily_cap_usd (1.50), slack_voice_enabled (true).
--   exec_slack_lead_channels    one row per lead channel he is in (a P7a lead deny marker): its kind and the DD client the FB
--                                 onboarding list maps it to. No channel name, nothing from any post.
--   exec_slack_lead_counts      whole numbers per lead channel per local day. Nothing else.
--   exec_slack_reply_drafts     one row per reply draft: the source message's refs, the destination (computed here from the
--                                 stored message, never input), the draft text, the status machine (CAS) and the send record.
--                                 FK to P7a's message row: every P7a purge of the source deletes the draft in the same transaction.
--   exec_slack_reply_cards      the assistant-DM cards that show a draft (refs only; outlives the draft).
--   exec_slack_voice_profile    his Slack writing style as enums (no free text) and the refs of the samples it came from.
--
-- Functions (SECURITY INVOKER, search_path pinned, EXECUTE for service_role only): the twenty-two locked down at the end.
--   exec_slack_fb_lead_channels_v2 = P7a's exec_slack_fb_lead_channels plus the onboarding's task and DD client.
--   exec_slack_accept_action_v3    = P8's exec_slack_accept_action_v2 copied verbatim plus the reply-draft buttons.
--   Neither earlier function, nor any other earlier object, is touched.
--
-- Security: RLS ON with NO policies; nothing granted to anon/authenticated.
-- Idempotent. Apply MANUALLY in the Supabase SQL editor AFTER 20261111100000_exec_brief.sql AND P9's
-- 20261111200000_exec_brief_dm_refs.sql: without P9's file the closing grid fails its three "unchanged (P9)" rows.
-- Nothing runs until EXEC_ENABLED=true and each feature's switch is turned on in Executive AI → Settings.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: refuse, with nothing changed, a database without P2a, P6, P7a or P8.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_settings') is null
     or to_regclass('public.exec_jobs') is null then
    raise exception 'exec P10 aborted, nothing changed: the P2a foundation is missing (apply 20261104100000_exec_foundation.sql first)';
  end if;
  if to_regclass('public.exec_slack_installations') is null or to_regclass('public.exec_slack_posts') is null then
    raise exception 'exec P10 aborted, nothing changed: P6 Slack is missing (apply 20261108100000_exec_slack.sql first)';
  end if;
  if to_regclass('public.exec_slack_channels') is null or to_regclass('public.exec_slack_messages') is null
     or to_regclass('public.exec_slack_items') is null or to_regclass('public.exec_slack_deleted') is null
     or to_regclass('public.exec_slack_purge_log') is null or to_regclass('public.exec_slack_author_optouts') is null then
    raise exception 'exec P10 aborted, nothing changed: P7a Slack reading is missing (apply 20261109100000_exec_slack_reading.sql first)';
  end if;
  if to_regclass('public.exec_briefs') is null
     or to_regprocedure('public.exec_slack_accept_action_v2(text, text, text, text, text, text, text, text, text)') is null then
    raise exception 'exec P10 aborted, nothing changed: P8 is missing (apply 20261111100000_exec_brief.sql first)';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_messages_pkey')
     or not exists (select 1 from pg_constraint where conname = 'exec_slack_channels_pkey') then
    raise exception 'exec P10 aborted, nothing changed: the P7a keys are missing (P7a migration incomplete)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. CHECK helpers (never dropped: CHECKs depend on them, as P7a's exec_slack_dd_paths_ok). A re-run replaces them with
--    the same signature and return type only.
-- ---------------------------------------------------------------------------

create or replace function public.exec_slack_ts_array_ok(p text[]) returns boolean
language sql immutable security invoker set search_path = ''
as $$
  select p is not null and coalesce(cardinality(p), 0) <= 200
     and not exists (select 1 from unnest(p) as x(v) where x.v is null or x.v !~ '^[0-9]{1,12}\.[0-9]{1,8}$');
$$;
create or replace function public.exec_slack_user_array_ok(p text[]) returns boolean
language sql immutable security invoker set search_path = ''
as $$
  select p is not null and coalesce(cardinality(p), 0) <= 200
     and not exists (select 1 from unnest(p) as x(v) where x.v is null or x.v !~ '^[UW][A-Z0-9]{2,30}$');
$$;
create or replace function public.exec_slack_ref_array_ok(p text[]) returns boolean
language sql immutable security invoker set search_path = ''
as $$
  select p is not null and coalesce(cardinality(p), 0) <= 200
     and not exists (select 1 from unnest(p) as x(v) where x.v is null or x.v !~ '^[CGD][A-Z0-9]{2,30}:[0-9]{1,12}\.[0-9]{1,8}$');
$$;
create or replace function public.exec_slack_channel_array_ok(p text[]) returns boolean
language sql immutable security invoker set search_path = ''
as $$
  select p is not null and coalesce(cardinality(p), 0) <= 200
     and not exists (select 1 from unnest(p) as x(v) where x.v is null or x.v !~ '^[CGD][A-Z0-9]{2,30}$');
$$;

-- ---------------------------------------------------------------------------
-- 2. exec_settings (C1, C23, C25, C30, C52): seven switches and the automatic-draft cap.
-- ---------------------------------------------------------------------------

alter table public.exec_settings add column if not exists slack_read_all            boolean not null default false;
alter table public.exec_settings add column if not exists slack_lead_counts_enabled boolean not null default false;
alter table public.exec_settings add column if not exists slack_replies_enabled     boolean not null default false;
alter table public.exec_settings add column if not exists slack_reply_send_enabled  boolean not null default false;
alter table public.exec_settings add column if not exists slack_reply_auto          boolean not null default false;
alter table public.exec_settings add column if not exists slack_reply_daily_cap_usd numeric(10, 2) not null default 1.50;
alter table public.exec_settings add column if not exists slack_voice_enabled       boolean not null default true;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exec_settings_slack_reply_cap_check') then
    alter table public.exec_settings add constraint exec_settings_slack_reply_cap_check
      check (slack_reply_daily_cap_usd >= 0 and slack_reply_daily_cap_usd <= 20);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. exec_slack_lead_channels (T2, C18-C20)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_lead_channels (
  principal_id    text not null,
  channel_id      text not null constraint exec_slack_lead_channels_id_check check (channel_id ~ '^[CG][A-Z0-9]{2,30}$'),
  installation_id text not null references public.exec_slack_installations(id) on delete cascade,
  kind            text not null constraint exec_slack_lead_channels_kind_check
                    check (kind in ('vob', 'nonvob', 'calendly', 'zap_errors', 'other')),
  link            text not null constraint exec_slack_lead_channels_link_check
                    check (link in ('fb_id', 'fb_name', 'fb_sibling', 'ambiguous', 'none')),
  -- From DD's own tables (the typed list's onboarding): ids and a display label. Never a Slack name.
  task_id         text constraint exec_slack_lead_channels_task_check check (task_id is null or char_length(task_id) between 1 and 64),
  client_id       text constraint exec_slack_lead_channels_client_check check (client_id is null or char_length(client_id) between 1 and 64),
  client_label    text constraint exec_slack_lead_channels_label_check
                    check (client_label is null or char_length(client_label) between 1 and 120),
  counted_from    date,
  final_through   date,
  -- v1.1 correctness-2: the last time a final (8-day) pass was attempted, capped or failed included; a channel needs its final
  -- pass again only when this is null or older than 6 hours (C15, C16).
  final_attempt_at timestamptz,
  counted_at      timestamptz,
  last_error_code text constraint exec_slack_lead_channels_error_check check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,60}$'),
  mapped_at       timestamptz not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint exec_slack_lead_channels_pkey primary key (principal_id, channel_id),
  -- The parent is P7a's bare deny marker: discovery removing it, Stop reading / revoke / uninstall (purge_reading), a
  -- 'deleted' lifecycle event and a re-key all reach these rows with no P7a code change.
  constraint exec_slack_lead_channels_channel_fkey foreign key (principal_id, channel_id)
    references public.exec_slack_channels (principal_id, channel_id) on update cascade on delete cascade,
  constraint exec_slack_lead_channels_link_pair_check
    check ((link in ('fb_id', 'fb_name', 'fb_sibling')) = (task_id is not null and client_label is not null)),
  constraint exec_slack_lead_channels_client_pair_check check (client_id is null or task_id is not null),
  constraint exec_slack_lead_channels_expiry_check
    check (expires_at > mapped_at and expires_at <= mapped_at + interval '401 days')
);
create index if not exists exec_slack_lead_channels_installation_idx on public.exec_slack_lead_channels (installation_id);
create index if not exists exec_slack_lead_channels_expires_idx on public.exec_slack_lead_channels (expires_at);
create index if not exists exec_slack_lead_channels_due_idx on public.exec_slack_lead_channels (principal_id, counted_at nulls first);

-- ---------------------------------------------------------------------------
-- 4. exec_slack_lead_counts (T2, C13-C15, C44)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_lead_counts (
  principal_id text not null,
  channel_id   text not null,
  local_day    date not null,
  tz           text not null constraint exec_slack_lead_counts_tz_check check (char_length(tz) between 1 and 64),
  n            integer not null constraint exec_slack_lead_counts_n_check check (n between 0 and 100000),
  -- C13: top-level posts by people (not apps) that day; a setup diagnostic, never per person.
  skipped      integer not null default 0 constraint exec_slack_lead_counts_skipped_check check (skipped between 0 and 100000),
  complete     boolean not null,
  counted_at   timestamptz not null,
  expires_at   timestamptz not null,
  constraint exec_slack_lead_counts_pkey primary key (principal_id, channel_id, local_day),
  constraint exec_slack_lead_counts_channel_fkey foreign key (principal_id, channel_id)
    references public.exec_slack_lead_channels (principal_id, channel_id) on update cascade on delete cascade,
  -- C44: the end of the local day + leadRetentionDays (retention_days_slack clamped to 7..365 by the app, v1.1 correctness-11),
  -- so never past day + 402 days in any zone.
  constraint exec_slack_lead_counts_ttl_check
    check (expires_at > counted_at and expires_at <= ((local_day + 402)::timestamp at time zone 'UTC'))
);
create index if not exists exec_slack_lead_counts_expires_idx on public.exec_slack_lead_counts (expires_at);
create index if not exists exec_slack_lead_counts_day_idx on public.exec_slack_lead_counts (principal_id, local_day);

-- ---------------------------------------------------------------------------
-- 5. exec_slack_reply_drafts (T3, C28, C34, C37, C44)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_reply_drafts (
  id                  text primary key default ('esr_' || replace(gen_random_uuid()::text, '-', ''))
                        constraint exec_slack_reply_drafts_id_check check (id ~ '^esr_[0-9a-f]{32}$'),
  principal_id        text not null,
  installation_id     text not null references public.exec_slack_installations(id) on delete cascade,
  channel_id          text not null constraint exec_slack_reply_drafts_channel_check check (channel_id ~ '^[CGD][A-Z0-9]{2,30}$'),
  conv_type           text not null constraint exec_slack_reply_drafts_conv_check check (conv_type in ('channel', 'group', 'im', 'mpim')),
  item_id             text constraint exec_slack_reply_drafts_item_check check (item_id is null or item_id ~ '^esl_[0-9a-f]{32}$'),
  source_ts           text not null constraint exec_slack_reply_drafts_source_ts_check check (source_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  -- The source's thread root when the source is a reply (P7a's normalization: null for a top-level message).
  source_thread_ts    text constraint exec_slack_reply_drafts_source_thread_check
                        check (source_thread_ts is null or (source_thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$' and source_thread_ts <> source_ts)),
  -- C28: where Send posts, computed by exec_slack_rdraft_create from the stored message row; never input.
  reply_thread_ts     text constraint exec_slack_reply_drafts_reply_thread_check
                        check (reply_thread_ts is null or reply_thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  origin              text not null constraint exec_slack_reply_drafts_origin_check check (origin in ('web', 'chat', 'slack', 'auto')),
  status              text not null default 'generating' constraint exec_slack_reply_drafts_status_check
                        check (status in ('generating', 'generation_failed', 'draft', 'sending', 'sent', 'unknown', 'failed',
                                          'discarded', 'expired', 'removed')),
  status_reason       text constraint exec_slack_reply_drafts_reason_check check (status_reason is null or status_reason ~ '^[a-z0-9_]{1,60}$'),
  version             integer not null default 0 constraint exec_slack_reply_drafts_version_check check (version between 0 and 9999),
  generation_seq      integer not null default 1 constraint exec_slack_reply_drafts_seq_check check (generation_seq between 1 and 1000),
  -- Content (§2.3): nulled, with content_purged_at, by every purge path.
  text                text constraint exec_slack_reply_drafts_text_check check (text is null or char_length(text) between 1 and 4000),
  instruction         text constraint exec_slack_reply_drafts_instruction_check
                        check (instruction is null or char_length(instruction) between 1 and 2000),
  note                text constraint exec_slack_reply_drafts_note_check check (note is null or char_length(note) between 1 and 400),
  placeholders        text[] not null default '{}' constraint exec_slack_reply_drafts_placeholders_check check (cardinality(placeholders) <= 20),
  edited              boolean not null default false,
  flags               text[] not null default '{}' constraint exec_slack_reply_drafts_flags_check
                        check (flags <@ array['unexpected_url', 'unexpected_email', 'unexpected_phone', 'unexpected_amount',
                                              'unexpected_number', 'mention', 'broadcast']::text[]),
  injection_suspected boolean not null default false,
  voice_source        text constraint exec_slack_reply_drafts_voice_check check (voice_source is null or voice_source in ('slack', 'email', 'house')),
  model               text constraint exec_slack_reply_drafts_model_check check (model is null or char_length(model) between 1 and 64),
  generation_error    text constraint exec_slack_reply_drafts_generror_check
                        check (generation_error is null or generation_error in ('refused', 'truncated', 'invalid_output', 'empty',
                               'too_long', 'copied_external', 'timeout', 'model_error', 'budget', 'context_unavailable', 'reading_off',
                               'channel', 'context_deleted', 'author_optout')),
  -- C47: refs of what the pack read (messages and their authors), for P7a's purge log and per-author opt-outs.
  context_ts          text[] not null default '{}' constraint exec_slack_reply_drafts_context_ts_check
                        check (cardinality(context_ts) <= 80 and public.exec_slack_ts_array_ok(context_ts)),
  context_authors     text[] not null default '{}' constraint exec_slack_reply_drafts_context_authors_check
                        check (cardinality(context_authors) <= 80 and public.exec_slack_user_array_ok(context_authors)),
  context_latest_ts   text constraint exec_slack_reply_drafts_latest_check
                        check (context_latest_ts is null or context_latest_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  source_edited_ts    text constraint exec_slack_reply_drafts_edited_check
                        check (source_edited_ts is null or source_edited_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  external            boolean not null,
  finance             boolean not null,
  generated_at        timestamptz,
  sending_at          timestamptz,
  audit_id            bigint,
  sent_at             timestamptz,
  posted_ts           text constraint exec_slack_reply_drafts_posted_check check (posted_ts is null or posted_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  posted_permalink    text constraint exec_slack_reply_drafts_permalink_check
                        check (posted_permalink is null or (char_length(posted_permalink) <= 500
                               and posted_permalink ~ '^https://[a-z0-9][a-z0-9-]*\.slack\.com/archives/[CGD][A-Z0-9]{2,30}/p[0-9]{10,20}')),
  sent_text_sha256    text constraint exec_slack_reply_drafts_sha_check check (sent_text_sha256 is null or sent_text_sha256 ~ '^[0-9a-f]{64}$'),
  -- v1.1 correctness-7: sha256 of the stored text's word key (replyWordsKey, §3.5.4); null when the text has no word token.
  sent_words_sha256   text constraint exec_slack_reply_drafts_words_check check (sent_words_sha256 is null or sent_words_sha256 ~ '^[0-9a-f]{64}$'),
  verify_checks       smallint not null default 0 constraint exec_slack_reply_drafts_verify_check check (verify_checks between 0 and 3),
  owner_resolution    text constraint exec_slack_reply_drafts_resolution_check
                        check (owner_resolution is null or owner_resolution in ('posted', 'not_posted')),
  -- The chat answer that started it (exec_messages ids are ecm_…); no FK: chat retention and draft retention are separate.
  chat_message_id     text constraint exec_slack_reply_drafts_chat_check check (chat_message_id is null or chat_message_id ~ '^ecm_[0-9a-f]{32}$'),
  terminal_at         timestamptz,
  content_purged_at   timestamptz,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Every P7a purge of the source message deletes the draft in the same transaction: a delete event, an absent or tombstoned
  -- message, a left / lost / deleted / denied / re-keyed / reinstalled conversation, an author opt-out, Stop reading, a revoke,
  -- an uninstall (purge_reading deletes the channel rows, their messages cascade) and the message's own TTL.
  constraint exec_slack_reply_drafts_message_fkey foreign key (principal_id, channel_id, source_ts)
    references public.exec_slack_messages (principal_id, channel_id, ts) on update cascade on delete cascade,
  -- C28: the source's own thread, nothing else; a channel always replies in a thread; a DM replies where the source is.
  constraint exec_slack_reply_drafts_destination_check
    check ((reply_thread_ts is null or reply_thread_ts = coalesce(source_thread_ts, source_ts))
           and (conv_type not in ('channel', 'group') or reply_thread_ts is not null)
           and (conv_type not in ('im', 'mpim') or reply_thread_ts is not distinct from source_thread_ts)),
  constraint exec_slack_reply_drafts_text_presence_check check (status <> 'draft' or text is not null),
  constraint exec_slack_reply_drafts_version_presence_check
    check (status not in ('draft', 'sending', 'sent', 'unknown', 'failed') or version >= 1),
  constraint exec_slack_reply_drafts_terminal_check
    check ((status in ('sent', 'failed', 'discarded', 'expired', 'removed')) = (terminal_at is not null)),
  constraint exec_slack_reply_drafts_sent_check check ((status = 'sent') = (sent_at is not null)),
  -- NULL-safe on purpose: with "owner_resolution = 'posted'" a sent row with neither posted_ts nor a resolution would make the
  -- expression NULL, and a NULL CHECK passes (SQ26: such a row is refused).
  constraint exec_slack_reply_drafts_sent_refs_check
    check (status <> 'sent' or posted_ts is not null or owner_resolution is not distinct from 'posted'),
  constraint exec_slack_reply_drafts_sending_check
    check (status not in ('sending', 'sent', 'unknown') or (sending_at is not null and audit_id is not null)),
  constraint exec_slack_reply_drafts_resolution_pair_check
    check (owner_resolution is null or (owner_resolution = 'posted' and status = 'sent') or (owner_resolution = 'not_posted' and status = 'failed')),
  constraint exec_slack_reply_drafts_generation_check check (status <> 'generation_failed' or generation_error is not null),
  constraint exec_slack_reply_drafts_content_check
    check (content_purged_at is null or (text is null and instruction is null and note is null and cardinality(placeholders) = 0)),
  constraint exec_slack_reply_drafts_expiry_check check (expires_at > created_at)
);
-- One active draft per message (C45).
create unique index if not exists exec_slack_reply_drafts_active_key on public.exec_slack_reply_drafts (principal_id, channel_id, source_ts)
  where status in ('generating', 'generation_failed', 'draft', 'sending', 'unknown');
create index if not exists exec_slack_reply_drafts_list_idx on public.exec_slack_reply_drafts (principal_id, status, updated_at desc);
-- v1.1 correctness-10: the FK's own columns, NOT partial, so the cascade query of every P7a message delete and re-key
-- (purge_expired, purge_conversation, mark_deleted, purge_author, rekey) uses an index instead of scanning his drafts.
create index if not exists exec_slack_reply_drafts_message_idx on public.exec_slack_reply_drafts (principal_id, channel_id, source_ts);
create index if not exists exec_slack_reply_drafts_context_ts_gin on public.exec_slack_reply_drafts using gin (context_ts);
create index if not exists exec_slack_reply_drafts_context_authors_gin on public.exec_slack_reply_drafts using gin (context_authors);
create index if not exists exec_slack_reply_drafts_expires_idx on public.exec_slack_reply_drafts (expires_at);
create index if not exists exec_slack_reply_drafts_posted_idx on public.exec_slack_reply_drafts (principal_id, posted_ts) where posted_ts is not null;
create index if not exists exec_slack_reply_drafts_inflight_idx on public.exec_slack_reply_drafts (principal_id, sending_at)
  where status in ('sending', 'unknown');
create index if not exists exec_slack_reply_drafts_installation_idx on public.exec_slack_reply_drafts (installation_id);

-- ---------------------------------------------------------------------------
-- 6. exec_slack_reply_cards and exec_slack_voice_profile (C25, C31)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_slack_reply_cards (
  installation_id  text not null references public.exec_slack_installations(id) on delete cascade,
  principal_id     text not null references public.exec_principals(id) on delete cascade,
  dm_channel_id    text not null constraint exec_slack_reply_cards_channel_check check (dm_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  dm_ts            text not null constraint exec_slack_reply_cards_ts_check check (dm_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  thread_ts        text constraint exec_slack_reply_cards_thread_check check (thread_ts is null or thread_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  -- No FK: the card outlives the draft so the sweep can turn it into the "no longer available" note (C31).
  draft_id         text not null constraint exec_slack_reply_cards_draft_check check (draft_id ~ '^esr_[0-9a-f]{32}$'),
  origin           text not null constraint exec_slack_reply_cards_origin_check check (origin in ('slack', 'auto')),
  rendered_version integer not null constraint exec_slack_reply_cards_version_check check (rendered_version between 0 and 9999),
  rendered_state   text not null constraint exec_slack_reply_cards_state_check
                     check (rendered_state in ('generating', 'failed_generation', 'live', 'dd_only', 'sending', 'sent', 'unknown', 'failed',
                                               'discarded', 'expired', 'removed', 'off')),
  posted_at        timestamptz not null default now(),
  followed_at      timestamptz,
  expires_at       timestamptz not null,
  constraint exec_slack_reply_cards_pkey primary key (installation_id, dm_ts),
  constraint exec_slack_reply_cards_expiry_check check (expires_at > posted_at)
);
create index if not exists exec_slack_reply_cards_draft_idx on public.exec_slack_reply_cards (principal_id, draft_id);
create index if not exists exec_slack_reply_cards_expires_idx on public.exec_slack_reply_cards (expires_at);
create index if not exists exec_slack_reply_cards_open_idx on public.exec_slack_reply_cards (principal_id)
  where rendered_state not in ('sent', 'failed', 'discarded', 'expired', 'removed', 'off');

create table if not exists public.exec_slack_voice_profile (
  principal_id       text primary key references public.exec_principals(id) on delete cascade,
  status             text not null constraint exec_slack_voice_profile_status_check check (status in ('ready', 'insufficient', 'failed')),
  formality          text constraint exec_slack_voice_profile_formality_check
                       check (formality is null or formality in ('very_casual', 'casual', 'neutral', 'formal')),
  typical_length     text constraint exec_slack_voice_profile_length_check
                       check (typical_length is null or typical_length in ('one_liner', 'short', 'medium', 'long')),
  capitalization     text constraint exec_slack_voice_profile_caps_check
                       check (capitalization is null or capitalization in ('mostly_lowercase', 'standard')),
  punctuation        text constraint exec_slack_voice_profile_punct_check check (punctuation is null or punctuation in ('minimal', 'standard')),
  greeting           text constraint exec_slack_voice_profile_greeting_check
                       check (greeting is null or greeting in ('none', 'name_only', 'hey_name', 'hi_name', 'mixed')),
  emoji              text constraint exec_slack_voice_profile_emoji_check check (emoji is null or emoji in ('never', 'rarely', 'sometimes', 'often')),
  abbreviations      text constraint exec_slack_voice_profile_abbrev_check check (abbreviations is null or abbreviations in ('never', 'sometimes', 'often')),
  exclamations       text constraint exec_slack_voice_profile_excl_check check (exclamations is null or exclamations in ('never', 'sometimes', 'often')),
  bullets            text constraint exec_slack_voice_profile_bullets_check check (bullets is null or bullets in ('never', 'sometimes', 'often')),
  sample_count       integer not null default 0 constraint exec_slack_voice_profile_count_check check (sample_count between 0 and 60),
  -- Refs only ("<channel>:<ts>"), so a deletion of a sampled message (P7a's purge log) drops the profile.
  sample_refs        text[] not null default '{}' constraint exec_slack_voice_profile_refs_check
                       check (cardinality(sample_refs) <= 60 and public.exec_slack_ref_array_ok(sample_refs)),
  sample_channels    text[] not null default '{}' constraint exec_slack_voice_profile_channels_check
                       check (cardinality(sample_channels) <= 10 and public.exec_slack_channel_array_ok(sample_channels)),
  samples_hash       text constraint exec_slack_voice_profile_hash_check check (samples_hash is null or samples_hash ~ '^[0-9a-f]{64}$'),
  model              text constraint exec_slack_voice_profile_model_check check (model is null or char_length(model) between 1 and 64),
  prompt_version     text not null constraint exec_slack_voice_profile_prompt_check check (char_length(prompt_version) between 1 and 40),
  last_attempt_error text constraint exec_slack_voice_profile_error_check
                       check (last_attempt_error is null or last_attempt_error in ('declined', 'truncated', 'invalid_output', 'budget',
                                                                                   'read_failed', 'insufficient')),
  built_at           timestamptz not null,
  expires_at         timestamptz not null,
  updated_at         timestamptz not null default now(),
  constraint exec_slack_voice_profile_ready_check
    check (status <> 'ready' or (formality is not null and typical_length is not null and capitalization is not null
                                 and punctuation is not null and greeting is not null and emoji is not null and abbreviations is not null
                                 and exclamations is not null and bullets is not null)),
  constraint exec_slack_voice_profile_expiry_check check (expires_at > built_at and expires_at <= built_at + interval '31 days')
);
create index if not exists exec_slack_voice_profile_expires_idx on public.exec_slack_voice_profile (expires_at);
create index if not exists exec_slack_voice_profile_refs_gin on public.exec_slack_voice_profile using gin (sample_refs);

-- ---------------------------------------------------------------------------
-- 7. exec_slack_fb_lead_channels_v2 (C20; P7a's v1 untouched: still the classifier's deny source)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_slack_fb_lead_channels_v2();
create or replace function public.exec_slack_fb_lead_channels_v2()
returns table (task_id text, client_id text, client_label text, name text, channel_id text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  r        record;
  v_list   jsonb;
  v_e      jsonb;
  v_slug   text;
  v_cid    text;
  v_clabel text;
begin
  -- P7a's exec_slack_fb_lead_channels() (unchanged: still the classifier's deny source) plus the onboarding's task and DD
  -- client. Selects ONLY the one key of the onboarding state (the EIN, CRM logins and every other key never leave the
  -- database), the task's client_name, title and deleted_at, and clients' id and name. A deleted task is skipped: its
  -- channels stay denied by v1 and are counted as unlinked. A missing fb_onboarding raises 42P01 at call time.
  for r in
    select o.task_id as tid, o.state -> 'access.notify.slack_channels' ->> 'v' as raw, t.client_name as cname, t.title as ttitle
      from public.fb_onboarding o
      join public.tasks t on t.id = o.task_id
     where o.state ? 'access.notify.slack_channels' and t.deleted_at is null
     order by o.task_id
  loop
    begin
      v_list := r.raw::jsonb;
    exception when others then
      continue;   -- malformed: read as no channels, as v1 does
    end;
    if v_list is null or jsonb_typeof(v_list) <> 'array' then continue; end if;
    v_cid := null;
    v_clabel := null;
    if r.cname is not null and btrim(r.cname) <> '' then
      select c.id, c.name into v_cid, v_clabel from public.clients c where c.name = r.cname limit 1;
      if v_cid is null then
        -- The one client whose name matches case-insensitively after trimming; two or more → none (fail toward unlinked).
        select min(c.id), min(c.name) into v_cid, v_clabel from public.clients c
         where lower(btrim(c.name)) = lower(btrim(r.cname))
        having count(*) = 1;
      end if;
    end if;
    if v_cid is null then
      v_clabel := coalesce(nullif(btrim(r.cname), ''), nullif(btrim(r.ttitle), ''), 'Unnamed onboarding');
    end if;
    for v_e in select value from jsonb_array_elements(v_list) limit 12 loop
      if jsonb_typeof(v_e) <> 'object' then continue; end if;
      v_slug := btrim(regexp_replace(lower(coalesce(v_e ->> 'name', '')), '[^a-z0-9]+', '-', 'g'), '-');
      task_id := r.tid;
      client_id := v_cid;
      client_label := left(v_clabel, 120);
      name := case when v_slug ~ '^[a-z0-9][a-z0-9-]{0,79}$' then v_slug end;
      channel_id := coalesce(substring(coalesce(v_e ->> 'url', '') from '/archives/([CG][A-Z0-9]{2,30})'),
                             substring(coalesce(v_e ->> 'url', '') from '/client/T[A-Z0-9]+/([CG][A-Z0-9]{2,30})'));
      if name is not null or channel_id is not null then return next; end if;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. The lead functions (B-P10-1: named only by slack-leads-store.ts). Lock order: every function that touches both takes the
--    P7a channel row first (FOR SHARE), then the lead row, so P7a's apply_classes (FOR UPDATE on the channel row) and these
--    serialize without deadlock; a class change away from deny committed first makes map_apply refuse and counts_put answer
--    refused.
-- ---------------------------------------------------------------------------

-- 1. The lead markers of one installation, plus the readable rows the typed list names (C24).
drop function if exists public.exec_slack_lead_markers(text, text, text[], text[]);
create or replace function public.exec_slack_lead_markers(p_principal text, p_installation text, p_listed_ids text[], p_listed_slugs text[])
returns table (channel_id text, conv_type text, class text, deny_reason text, listed boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.channel_id, c.conv_type, c.class, c.deny_reason,
         (c.channel_id = any (coalesce(p_listed_ids, '{}'::text[]))
          or (c.name is not null
              and btrim(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), '-') = any (coalesce(p_listed_slugs, '{}'::text[]))))
    from public.exec_slack_channels c
   where c.principal_id = p_principal and c.installation_id = p_installation
     and ((c.class = 'deny' and c.deny_reason in ('fb_list', 'lead_name') and c.conv_type in ('channel', 'group'))
          or (c.class <> 'deny'
              and (c.channel_id = any (coalesce(p_listed_ids, '{}'::text[]))
                   or (c.name is not null
                       and btrim(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), '-') = any (coalesce(p_listed_slugs, '{}'::text[]))))))
   order by c.channel_id
   limit 2000;
$$;

-- 2. The map (C18-C20): upsert only onto a lead marker of this installation; drop rows whose parent no longer is one; on a
--    complete run also drop the rows the run didn't list (left, unlisted). Channel row FOR SHARE first (P7a's C50 order).
drop function if exists public.exec_slack_lead_map_apply(text, text, jsonb, boolean, timestamptz, timestamptz);
create or replace function public.exec_slack_lead_map_apply(p_principal text, p_installation text, p_rows jsonb, p_complete boolean,
                                                            p_mapped_at timestamptz, p_expires_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r        jsonb;
  v_cls    text;
  v_reason text;
  v_inst   text;
  v_ids    text[] := '{}';
  v_n      integer;
  v_up     integer := 0;
  v_ref    integer := 0;
  v_del    integer := 0;
begin
  if p_principal is null or p_installation is null then raise exception 'exec_slack_lead_map_apply: principal and installation are required'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'exec_slack_lead_map_apply: rows'; end if;
  if p_mapped_at is null or p_expires_at is null or p_expires_at <= p_mapped_at then raise exception 'exec_slack_lead_map_apply: times'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    if r ->> 'channel_id' is null or r ->> 'channel_id' !~ '^[CG][A-Z0-9]{2,30}$'
       or coalesce(r ->> 'kind', '') not in ('vob', 'nonvob', 'calendly', 'zap_errors', 'other')
       or coalesce(r ->> 'link', '') not in ('fb_id', 'fb_name', 'fb_sibling', 'ambiguous', 'none') then
      raise exception 'exec_slack_lead_map_apply: bad row';
    end if;
    select c.class, c.deny_reason, c.installation_id into v_cls, v_reason, v_inst
      from public.exec_slack_channels c
     where c.principal_id = p_principal and c.channel_id = r ->> 'channel_id'
       for share;
    if v_cls is distinct from 'deny' or coalesce(v_reason, '') not in ('fb_list', 'lead_name') or v_inst is distinct from p_installation then
      v_ref := v_ref + 1;
      continue;
    end if;
    insert into public.exec_slack_lead_channels (principal_id, channel_id, installation_id, kind, link, task_id, client_id, client_label,
                                                 mapped_at, expires_at)
    values (p_principal, r ->> 'channel_id', p_installation, r ->> 'kind', r ->> 'link', r ->> 'task_id', r ->> 'client_id',
            left(r ->> 'client_label', 120), p_mapped_at, p_expires_at)
    on conflict (principal_id, channel_id) do update
      set installation_id = excluded.installation_id, kind = excluded.kind, link = excluded.link, task_id = excluded.task_id,
          client_id = excluded.client_id, client_label = excluded.client_label, mapped_at = excluded.mapped_at,
          expires_at = excluded.expires_at, updated_at = now();
    v_ids := v_ids || (r ->> 'channel_id');
    v_up := v_up + 1;
  end loop;
  delete from public.exec_slack_lead_channels l
   where l.principal_id = p_principal
     and not exists (select 1 from public.exec_slack_channels c
                      where c.principal_id = l.principal_id and c.channel_id = l.channel_id and c.class = 'deny'
                        and c.deny_reason in ('fb_list', 'lead_name') and c.installation_id = l.installation_id);
  get diagnostics v_n = row_count;
  v_del := v_del + v_n;
  if coalesce(p_complete, false) then
    delete from public.exec_slack_lead_channels l where l.principal_id = p_principal and not (l.channel_id = any (v_ids));
    get diagnostics v_n = row_count;
    v_del := v_del + v_n;
  end if;
  return jsonb_build_object('upserted', v_up, 'refused', v_ref, 'deleted', v_del);
end;
$$;

-- 3. One channel's days (C13-C15): replaces each day given (never increments), only while the parent is a lead marker.
--    v1.1 correctness-2: a day sent as a lower bound (complete false: its read hit the page cap) never replaces a stored row
--    with a smaller number; days the run didn't read in full are not sent at all; p_final_attempt stamps final_attempt_at.
drop function if exists public.exec_slack_lead_counts_put(text, text, text, date, jsonb, timestamptz, date, boolean);
create or replace function public.exec_slack_lead_counts_put(p_principal text, p_channel text, p_tz text, p_today date, p_days jsonb,
                                                             p_counted_at timestamptz, p_final_through date, p_final_attempt boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cls    text;
  v_reason text;
  d        jsonb;
  v_day    date;
  v_min    date;
  v_n      integer := 0;
  v_kept   integer := 0;
  v_rc     integer;
begin
  if p_tz is null or char_length(p_tz) not between 1 and 64 then raise exception 'exec_slack_lead_counts_put: tz'; end if;
  if p_today is null or abs(p_today - (now() at time zone 'UTC')::date) > 1 then raise exception 'exec_slack_lead_counts_put: today'; end if;
  -- 0 days is allowed (a capped read with no usable post still stamps counted_at / final_attempt_at).
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) > 10 then raise exception 'exec_slack_lead_counts_put: days'; end if;
  if p_final_through is not null and p_final_through <> p_today - 1 then raise exception 'exec_slack_lead_counts_put: final_through'; end if;
  select c.class, c.deny_reason into v_cls, v_reason from public.exec_slack_channels c
   where c.principal_id = p_principal and c.channel_id = p_channel for share;
  if v_cls is distinct from 'deny' or coalesce(v_reason, '') not in ('fb_list', 'lead_name') then
    return jsonb_build_object('outcome', 'refused');
  end if;
  perform 1 from public.exec_slack_lead_channels l where l.principal_id = p_principal and l.channel_id = p_channel for update;
  if not found then return jsonb_build_object('outcome', 'no_row'); end if;
  for d in select value from jsonb_array_elements(p_days) loop
    v_day := (d ->> 'd')::date;
    if v_day is null or v_day < p_today - 8 or v_day > p_today + 1
       or coalesce(jsonb_typeof(d -> 'n'), '') <> 'number' or coalesce(jsonb_typeof(d -> 'skipped'), '') <> 'number'
       or coalesce(jsonb_typeof(d -> 'complete'), '') <> 'boolean' or (d ->> 'expires_at') is null then
      raise exception 'exec_slack_lead_counts_put: bad day';
    end if;
    insert into public.exec_slack_lead_counts (principal_id, channel_id, local_day, tz, n, skipped, complete, counted_at, expires_at)
    values (p_principal, p_channel, v_day, p_tz, (d ->> 'n')::integer, (d ->> 'skipped')::integer, (d ->> 'complete')::boolean,
            p_counted_at, (d ->> 'expires_at')::timestamptz)
    on conflict (principal_id, channel_id, local_day) do update
      set tz = excluded.tz, n = excluded.n, skipped = excluded.skipped, complete = excluded.complete,
          counted_at = excluded.counted_at, expires_at = excluded.expires_at
      -- A full read always wins; a lower bound only raises (never lowers) what is stored.
      where excluded.complete or excluded.n >= public.exec_slack_lead_counts.n;
    get diagnostics v_rc = row_count;
    if v_rc = 0 then v_kept := v_kept + 1; end if;
    v_min := least(coalesce(v_min, v_day), v_day);
    v_n := v_n + 1;
  end loop;
  update public.exec_slack_lead_channels
     set counted_at = p_counted_at,
         counted_from = case when v_min is null then counted_from else least(coalesce(counted_from, v_min), v_min) end,
         final_through = case when p_final_through is null then final_through else greatest(coalesce(final_through, p_final_through), p_final_through) end,
         final_attempt_at = case when coalesce(p_final_attempt, false) then p_counted_at else final_attempt_at end,
         last_error_code = null,
         updated_at = now()
   where principal_id = p_principal and channel_id = p_channel;
  return jsonb_build_object('outcome', 'written', 'days', v_n, 'kept', v_kept);
end;
$$;

-- 4. Sums per client group × kind × day; only rows whose parent is still a lead marker of the row's installation.
drop function if exists public.exec_slack_lead_summary(text, date, date);
create or replace function public.exec_slack_lead_summary(p_principal text, p_from date, p_to date)
returns table (group_key text, client_id text, task_id text, client_label text, kind text, local_day date, n bigint, channels integer,
               complete boolean, oldest_counted_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select case when l.link in ('fb_id', 'fb_name', 'fb_sibling') then coalesce('c:' || l.client_id, 't:' || l.task_id) else 'unlinked' end,
         min(l.client_id), min(l.task_id), min(l.client_label), l.kind, k.local_day, sum(k.n)::bigint,
         count(distinct l.channel_id)::integer, bool_and(k.complete), min(l.counted_at)
    from public.exec_slack_lead_counts k
    join public.exec_slack_lead_channels l on l.principal_id = k.principal_id and l.channel_id = k.channel_id
    join public.exec_slack_channels c on c.principal_id = l.principal_id and c.channel_id = l.channel_id
   where k.principal_id = p_principal
     and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 31
     and k.local_day between p_from and p_to
     and k.expires_at > now()
     and c.class = 'deny' and c.deny_reason in ('fb_list', 'lead_name') and c.installation_id = l.installation_id
   group by 1, l.kind, k.local_day
   order by 1, l.kind, k.local_day;
$$;

-- 5. Coverage for the Slack tab, Settings and the System card (counts only).
drop function if exists public.exec_slack_lead_coverage(text, date);
create or replace function public.exec_slack_lead_coverage(p_principal text, p_today date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'channels', count(*),
    'linked', count(*) filter (where l.link in ('fb_id', 'fb_name', 'fb_sibling') and l.kind <> 'other'),
    'unlinked', count(*) filter (where l.link = 'none' and l.kind <> 'other'),
    'ambiguous', count(*) filter (where l.link = 'ambiguous' and l.kind <> 'other'),
    'other_kind', count(*) filter (where l.kind = 'other'),
    'with_error', count(*) filter (where l.last_error_code is not null),
    'never_counted', count(*) filter (where l.counted_at is null),
    'oldest_counted_at', min(l.counted_at),
    'skipped_today', coalesce((select sum(k.skipped) from public.exec_slack_lead_counts k
                                where k.principal_id = p_principal and k.local_day = p_today), 0))
    from public.exec_slack_lead_channels l
    join public.exec_slack_channels c on c.principal_id = l.principal_id and c.channel_id = l.channel_id
   where l.principal_id = p_principal and c.class = 'deny' and c.deny_reason in ('fb_list', 'lead_name');
$$;

-- 6. Lead counts switched off, reading gone (C23): everything of the principal.
drop function if exists public.exec_slack_lead_purge_principal(text);
create or replace function public.exec_slack_lead_purge_principal(p_principal text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_counts   integer;
  v_channels integer;
begin
  delete from public.exec_slack_lead_counts where principal_id = p_principal;
  get diagnostics v_counts = row_count;
  delete from public.exec_slack_lead_channels where principal_id = p_principal;
  get diagnostics v_channels = row_count;
  return jsonb_build_object('counts', v_counts, 'channels', v_channels);
end;
$$;

-- 7. TTLs (C44), principal-agnostic (the system purge).
drop function if exists public.exec_slack_lead_purge_expired(timestamptz);
create or replace function public.exec_slack_lead_purge_expired(p_now timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_counts   integer;
  v_channels integer;
begin
  delete from public.exec_slack_lead_counts
   where ctid in (select ctid from public.exec_slack_lead_counts where expires_at < v_now limit 5000);
  get diagnostics v_counts = row_count;
  delete from public.exec_slack_lead_channels where expires_at < v_now;
  get diagnostics v_channels = row_count;
  return jsonb_build_object('counts', v_counts, 'channels', v_channels);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The reply-draft functions (B-P10-2: named only by slack-reply-store.ts)
-- ---------------------------------------------------------------------------

-- 13. Create (C28, C45, C46): the destination from the stored message row only; one active draft per message.
drop function if exists public.exec_slack_rdraft_create(text, text, text, text, text, text, text, text, text, timestamptz);
create or replace function public.exec_slack_rdraft_create(
  p_principal       text,
  p_installation    text,
  p_channel         text,
  p_ts              text,
  p_item_id         text,          -- the item he asked from, or null (chat by an attention ref, the planner resolves one)
  p_origin          text,          -- 'web' | 'chat' | 'slack' | 'auto'
  p_instruction     text,          -- his words (C51), or null
  p_from_draft      text,          -- v1.1 security-6 / correctness-13: 'web' only, "Start a new draft with this text" (C37):
                                   -- the id of HIS failed / not_posted draft of THIS message; the text and every safety field are
                                   -- copied here in SQL (the app never supplies draft text to this function) → a ready draft
  p_chat_message_id text,
  p_expires_at      timestamptz    -- now + 7 days (C44), computed by the app
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inst  public.exec_slack_installations%rowtype;
  v_ch    public.exec_slack_channels%rowtype;
  v_msg   public.exec_slack_messages%rowtype;
  v_row   public.exec_slack_reply_drafts%rowtype;
  v_src   public.exec_slack_reply_drafts%rowtype;
  v_reply text;
begin
  if p_principal is null or p_installation is null then raise exception 'exec_slack_rdraft_create: principal and installation are required'; end if;
  if p_origin is null or p_origin not in ('web', 'chat', 'slack', 'auto') then raise exception 'exec_slack_rdraft_create: bad origin'; end if;
  if p_channel is null or p_channel !~ '^[CGD][A-Z0-9]{2,30}$' or p_ts is null or p_ts !~ '^[0-9]{1,12}\.[0-9]{1,8}$' then
    raise exception 'exec_slack_rdraft_create: bad channel or ts';
  end if;
  if p_item_id is not null and p_item_id !~ '^esl_[0-9a-f]{32}$' then raise exception 'exec_slack_rdraft_create: bad item'; end if;
  if p_instruction is not null and char_length(p_instruction) not between 1 and 2000 then raise exception 'exec_slack_rdraft_create: instruction'; end if;
  if p_from_draft is not null and (p_origin <> 'web' or p_from_draft !~ '^esr_[0-9a-f]{32}$' or p_instruction is not null) then
    raise exception 'exec_slack_rdraft_create: from_draft';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '8 days' then
    raise exception 'exec_slack_rdraft_create: expires_at';
  end if;
  select * into v_inst from public.exec_slack_installations i where i.id = p_installation;
  if not found or v_inst.principal_id <> p_principal or v_inst.revoked_at is not null or v_inst.user_token_enc is null
     or v_inst.reading_state not in ('discovering', 'ready') then
    return jsonb_build_object('outcome', 'refused', 'reason', 'not_reading');
  end if;
  -- C50 (P7a): the channel row first (FOR SHARE), then the message row.
  select * into v_ch from public.exec_slack_channels c where c.principal_id = p_principal and c.channel_id = p_channel for share;
  if not found or v_ch.installation_id <> p_installation or v_ch.class not in ('standard', 'external', 'finance')
     or not v_ch.is_member or v_ch.left_at is not null then
    return jsonb_build_object('outcome', 'refused', 'reason', 'channel');
  end if;
  select * into v_msg from public.exec_slack_messages m
   where m.principal_id = p_principal and m.channel_id = p_channel and m.ts = p_ts for share;
  if not found or v_msg.role = 'anchor' or v_msg.author_user_id is not distinct from v_inst.user_id then
    return jsonb_build_object('outcome', 'refused', 'reason', 'message');
  end if;
  if exists (select 1 from public.exec_slack_deleted d where d.principal_id = p_principal and d.channel_id = p_channel and d.ts = p_ts) then
    return jsonb_build_object('outcome', 'refused', 'reason', 'deleted');
  end if;
  if v_msg.author_user_id is not null and exists (select 1 from public.exec_slack_author_optouts o
       where o.principal_id = p_principal and o.author_user_id = v_msg.author_user_id) then
    return jsonb_build_object('outcome', 'refused', 'reason', 'author_optout');
  end if;
  if p_item_id is not null and not exists (select 1 from public.exec_slack_items i where i.id = p_item_id
       and i.principal_id = p_principal and i.channel_id = p_channel and i.ts = p_ts) then
    return jsonb_build_object('outcome', 'refused', 'reason', 'item');
  end if;
  -- v1.1 security-6 / correctness-13: "Start a new draft with this text" only from his own failed / not_posted draft of THIS
  -- message, its content still present; refused when any message or author it rests on is gone (H7 still holds for the copy).
  if p_from_draft is not null then
    select * into v_src from public.exec_slack_reply_drafts s where s.id = p_from_draft and s.principal_id = p_principal for update;
    if not found or v_src.status <> 'failed' or v_src.owner_resolution is distinct from 'not_posted'
       or v_src.text is null or v_src.content_purged_at is not null then
      return jsonb_build_object('outcome', 'refused', 'reason', 'from_draft');
    end if;
    if v_src.channel_id <> p_channel or v_src.source_ts <> p_ts or v_src.installation_id <> p_installation then
      return jsonb_build_object('outcome', 'refused', 'reason', 'from_draft_mismatch');
    end if;
    if exists (select 1 from public.exec_slack_deleted x where x.principal_id = p_principal and x.channel_id = p_channel
                and x.ts = any (v_src.context_ts)) then
      return jsonb_build_object('outcome', 'refused', 'reason', 'deleted');
    end if;
    if exists (select 1 from public.exec_slack_author_optouts o where o.principal_id = p_principal
                and o.author_user_id = any (v_src.context_authors)) then
      return jsonb_build_object('outcome', 'refused', 'reason', 'author_optout');
    end if;
  end if;
  select * into v_row from public.exec_slack_reply_drafts d
   where d.principal_id = p_principal and d.channel_id = p_channel and d.source_ts = p_ts
     and d.status in ('generating', 'generation_failed', 'draft', 'sending', 'unknown');
  if found then
    return jsonb_build_object('outcome', 'existing', 'id', v_row.id, 'status', v_row.status, 'version', v_row.version,
                              'generation_seq', v_row.generation_seq, 'edited', v_row.edited);
  end if;
  -- C28: the destination, from the stored row only.
  v_reply := case when v_ch.conv_type in ('channel', 'group') then coalesce(v_msg.thread_ts, v_msg.ts) else v_msg.thread_ts end;
  insert into public.exec_slack_reply_drafts (principal_id, installation_id, channel_id, conv_type, item_id, source_ts, source_thread_ts,
                                              reply_thread_ts, origin, status, version, text, instruction, note, placeholders, edited,
                                              flags, injection_suspected, voice_source, model, generated_at, context_ts,
                                              context_authors, context_latest_ts, source_edited_ts, external, finance,
                                              chat_message_id, expires_at)
  values (p_principal, p_installation, p_channel, v_ch.conv_type, p_item_id, p_ts, v_msg.thread_ts, v_reply, p_origin,
          case when p_from_draft is null then 'generating' else 'draft' end, case when p_from_draft is null then 0 else 1 end,
          v_src.text, coalesce(p_instruction, v_src.instruction), v_src.note, coalesce(v_src.placeholders, '{}'),
          coalesce(v_src.edited, false), coalesce(v_src.flags, '{}'), coalesce(v_src.injection_suspected, false),
          v_src.voice_source, v_src.model, v_src.generated_at, coalesce(v_src.context_ts, '{}'),
          coalesce(v_src.context_authors, '{}'), v_src.context_latest_ts,
          -- A copy keeps the snapshot it was written against, so an edit since then still raises source_edited.
          case when p_from_draft is null then v_msg.edited_ts else v_src.source_edited_ts end,
          v_ch.class = 'external' or v_ch.is_ext_shared or v_ch.ext_ever or v_msg.author_external or coalesce(v_src.external, false),
          v_ch.class = 'finance' or v_ch.finance_name or coalesce(v_src.finance, false), p_chat_message_id, p_expires_at)
  on conflict (principal_id, channel_id, source_ts) where status in ('generating', 'generation_failed', 'draft', 'sending', 'unknown')
  do nothing
  returning * into v_row;
  if not found then
    select * into v_row from public.exec_slack_reply_drafts d
     where d.principal_id = p_principal and d.channel_id = p_channel and d.source_ts = p_ts
       and d.status in ('generating', 'generation_failed', 'draft', 'sending', 'unknown');
    return jsonb_build_object('outcome', 'existing', 'id', v_row.id, 'status', v_row.status, 'version', v_row.version,
                              'generation_seq', v_row.generation_seq, 'edited', v_row.edited);
  end if;
  return jsonb_build_object('outcome', 'created', 'id', v_row.id, 'status', v_row.status, 'version', v_row.version,
                            'generation_seq', v_row.generation_seq, 'edited', v_row.edited);
end;
$$;

-- 14. Rewrite (web, chat, Slack): claims a draft or a failed first generation for a new generation; the previous text stays
--     while it runs (a failed rewrite of a row that already had text returns to draft with it, RPC 15).
drop function if exists public.exec_slack_rdraft_regenerate(text, text, integer, text, boolean, timestamptz);
create or replace function public.exec_slack_rdraft_regenerate(p_principal text, p_id text, p_expected_version integer,
                                                               p_instruction text, p_keep_instruction boolean, p_expires_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v public.exec_slack_reply_drafts%rowtype;
begin
  if p_instruction is not null and char_length(p_instruction) not between 1 and 2000 then raise exception 'exec_slack_rdraft_regenerate: instruction'; end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '8 days' then raise exception 'exec_slack_rdraft_regenerate: expires_at'; end if;
  select * into v from public.exec_slack_reply_drafts d where d.id = p_id and d.principal_id = p_principal for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v.status not in ('draft', 'generation_failed') then return jsonb_build_object('outcome', 'busy', 'status', v.status); end if;
  if p_expected_version is null or v.version <> p_expected_version then
    return jsonb_build_object('outcome', 'conflict', 'version', v.version);
  end if;
  if v.generation_seq >= 1000 then return jsonb_build_object('outcome', 'busy', 'status', v.status); end if;
  update public.exec_slack_reply_drafts
     set status = 'generating', generation_seq = v.generation_seq + 1,
         instruction = case when coalesce(p_keep_instruction, false) then v.instruction else p_instruction end,
         status_reason = null, generation_error = null, expires_at = p_expires_at, updated_at = now()
   where id = p_id;
  return jsonb_build_object('outcome', 'claimed', 'generation_seq', v.generation_seq + 1, 'version', v.version);
end;
$$;

-- 15. Finish (the generation's one write; seq-fenced).
drop function if exists public.exec_slack_rdraft_finish(text, text, integer, jsonb);
create or replace function public.exec_slack_rdraft_finish(p_principal text, p_id text, p_seq integer, p_out jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
-- p_out: { ok, error?, text?, note?, placeholders?[], flags?[], injection_suspected?, voice_source?, model?, context_ts?[],
--          context_authors?[], context_latest_ts?, external_seen?, expires_at }. Written as given; the table's CHECKs validate
--          every field. v1.1 security-4: external_seen = an author from outside the company was among the context messages.
declare
  v        public.exec_slack_reply_drafts%rowtype;
  v_ch     public.exec_slack_channels%rowtype;
  v_ok     boolean;
  v_err    text;
  v_ctx    text[];
  v_auth   text[];
  v_edited text;
begin
  if p_out is null or jsonb_typeof(p_out) <> 'object' or coalesce(jsonb_typeof(p_out -> 'ok'), '') <> 'boolean' then
    raise exception 'exec_slack_rdraft_finish: bad output';
  end if;
  if p_out ? 'external_seen' and coalesce(jsonb_typeof(p_out -> 'external_seen'), '') <> 'boolean' then
    raise exception 'exec_slack_rdraft_finish: bad output';
  end if;
  select * into v from public.exec_slack_reply_drafts d where d.id = p_id and d.principal_id = p_principal;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  -- C50 (P7a): the channel row, then the message row, then the draft. v1.1 product-17: the message's current edited_ts is read
  -- under that lock, so a successful generation snapshots the text it was written from.
  select * into v_ch from public.exec_slack_channels c where c.principal_id = p_principal and c.channel_id = v.channel_id for share;
  select m.edited_ts into v_edited from public.exec_slack_messages m
   where m.principal_id = p_principal and m.channel_id = v.channel_id and m.ts = v.source_ts for share;
  select * into v from public.exec_slack_reply_drafts d where d.id = p_id for update;
  if not found or v.status <> 'generating' or v.generation_seq <> p_seq then return jsonb_build_object('outcome', 'stale'); end if;
  v_ok := (p_out ->> 'ok')::boolean;
  v_ctx := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p_out -> 'context_ts') = 'array'
                                                               then p_out -> 'context_ts' else '[]'::jsonb end)), '{}');
  v_auth := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p_out -> 'context_authors') = 'array'
                                                                then p_out -> 'context_authors' else '[]'::jsonb end)), '{}');
  v_err := case
    when not v_ok then coalesce(p_out ->> 'error', 'model_error')
    when v_ch.channel_id is null or v_ch.class not in ('standard', 'external', 'finance') or not v_ch.is_member or v_ch.left_at is not null
      then 'channel'
    when exists (select 1 from public.exec_slack_deleted x where x.principal_id = p_principal and x.channel_id = v.channel_id
                  and (x.ts = v.source_ts or x.ts = any (v_ctx))) then 'context_deleted'
    when exists (select 1 from public.exec_slack_author_optouts o where o.principal_id = p_principal and o.author_user_id = any (v_auth))
      then 'author_optout'
    else null end;
  if v_err is not null then
    if v_err in ('context_deleted', 'author_optout') and v.version >= 1 then
      -- The previous text may rest on the same messages: the whole draft goes.
      update public.exec_slack_reply_drafts
         set status = 'removed', status_reason = v_err, terminal_at = now(), text = null, instruction = null, note = null,
             placeholders = '{}', content_purged_at = now(), expires_at = now() + interval '30 days', updated_at = now()
       where id = p_id;
    elsif v.version >= 1 then
      update public.exec_slack_reply_drafts set status = 'draft', status_reason = v_err, updated_at = now() where id = p_id;
    else
      update public.exec_slack_reply_drafts set status = 'generation_failed', generation_error = v_err, updated_at = now() where id = p_id;
    end if;
    return jsonb_build_object('outcome', 'failed', 'error', v_err);
  end if;
  update public.exec_slack_reply_drafts
     set status = 'draft', text = p_out ->> 'text', note = nullif(p_out ->> 'note', ''),
         placeholders = coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p_out -> 'placeholders') = 'array'
                                                                            then p_out -> 'placeholders' else '[]'::jsonb end)), '{}'),
         flags = coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p_out -> 'flags') = 'array'
                                                                     then p_out -> 'flags' else '[]'::jsonb end)), '{}'),
         injection_suspected = coalesce((p_out ->> 'injection_suspected')::boolean, false),
         voice_source = p_out ->> 'voice_source', model = p_out ->> 'model',
         context_ts = v_ctx, context_authors = v_auth, context_latest_ts = p_out ->> 'context_latest_ts',
         source_edited_ts = v_edited,
         external = v.external or coalesce((p_out ->> 'external_seen')::boolean, false),
         generated_at = now(), version = least(v.version + 1, 9999), edited = false, status_reason = null, generation_error = null,
         expires_at = (p_out ->> 'expires_at')::timestamptz, updated_at = now()
   where id = p_id;
  return jsonb_build_object('outcome', 'written', 'version', least(v.version + 1, 9999));
end;
$$;

-- 16. His edit (C34: the app stores sanitizeChars(NFC(text)); placeholders recomputed by the app; flags kept: they describe the
--     AI's text, and the edited text may still hold it).
drop function if exists public.exec_slack_rdraft_edit(text, text, integer, text, text[], timestamptz);
create or replace function public.exec_slack_rdraft_edit(p_principal text, p_id text, p_expected_version integer, p_text text,
                                                         p_placeholders text[], p_expires_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version integer;
  v         public.exec_slack_reply_drafts%rowtype;
begin
  if p_text is null or char_length(p_text) not between 1 and 4000 then raise exception 'exec_slack_rdraft_edit: text'; end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '8 days' then raise exception 'exec_slack_rdraft_edit: expires_at'; end if;
  update public.exec_slack_reply_drafts
     set text = p_text, placeholders = coalesce(p_placeholders, '{}'), edited = true, version = least(version + 1, 9999),
         status_reason = null, expires_at = p_expires_at, updated_at = now()
   where id = p_id and principal_id = p_principal and status = 'draft' and version = p_expected_version and content_purged_at is null
  returning version into v_version;
  if found then return jsonb_build_object('outcome', 'updated', 'version', v_version); end if;
  select * into v from public.exec_slack_reply_drafts d where d.id = p_id and d.principal_id = p_principal;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  return jsonb_build_object('outcome', 'conflict', 'status', v.status, 'version', v.version);
end;
$$;

-- 17. The send-time facts (C48, §3.5.8 step 6), in one read. Missing rows fail closed (finance and external true).
drop function if exists public.exec_slack_rdraft_target(text, text);
create or replace function public.exec_slack_rdraft_target(p_principal text, p_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v      public.exec_slack_reply_drafts%rowtype;
  v_inst public.exec_slack_installations%rowtype;
  v_ch   public.exec_slack_channels%rowtype;
  v_msg  public.exec_slack_messages%rowtype;
  v_live boolean;
  v_resp timestamptz;
  v_urg  text;
begin
  select * into v from public.exec_slack_reply_drafts d where d.id = p_id and d.principal_id = p_principal;
  if not found then return jsonb_build_object('found', false); end if;
  select * into v_inst from public.exec_slack_installations i where i.id = v.installation_id;
  v_live := v_inst.id is not null and v_inst.revoked_at is null and v_inst.user_token_enc is not null
            and v_inst.reading_state in ('discovering', 'ready')
            and coalesce((select s.slack_reading_enabled from public.exec_settings s where s.principal_id = p_principal), false);
  select * into v_ch from public.exec_slack_channels c where c.principal_id = p_principal and c.channel_id = v.channel_id;
  select * into v_msg from public.exec_slack_messages m where m.principal_id = p_principal and m.channel_id = v.channel_id and m.ts = v.source_ts;
  select max(i.responded_at) into v_resp from public.exec_slack_items i
   where i.principal_id = p_principal and i.channel_id = v.channel_id and i.ts = v.source_ts;
  select i.urgency into v_urg from public.exec_slack_items i where i.id = v.item_id and i.principal_id = p_principal;
  return jsonb_build_object(
    'found', true,
    'reading_live', coalesce(v_live, false),
    'channel_ok', v_ch.channel_id is not null and v_ch.class in ('standard', 'external', 'finance') and v_ch.is_member
                  and v_ch.left_at is null and v_ch.installation_id = v.installation_id,
    'finance', coalesce(v_ch.class = 'finance' or v_ch.finance_name, true) or v.finance,
    -- v1.1 security-4: also any stored message of the conversation by an author P7a judged external (fail closed, per message,
    -- slack-ingest.ts:432-442), not only the conversation's own flags.
    'external', coalesce(v_ch.class = 'external' or v_ch.is_ext_shared or v_ch.ext_ever, true) or v.external
                or exists (select 1 from public.exec_slack_messages m where m.principal_id = p_principal
                            and m.channel_id = v.channel_id and m.author_external),
    'message', v_msg.ts is not null,
    'deleted', exists (select 1 from public.exec_slack_deleted x where x.principal_id = p_principal and x.channel_id = v.channel_id
                        and x.ts = v.source_ts),
    'edited_ts', v_msg.edited_ts,
    'responded_at', greatest(v_resp, v_msg.responded_at),
    'item_urgency', v_urg);
end;
$$;

-- 18. P7a's purge log and opt-outs, followed (C44, §3.5.9 sweep): blank every draft that rests on a deleted message or an
--     opted-out author. Open drafts become 'removed'; drafts already sending, sent or closed keep their status and lose their
--     content. Returns the ids it changed (the sweep re-renders their cards).
--     v1.1 correctness-6: p_before (the purge-log row's created_at) limits a message-scope blank to drafts created at or before
--     the deletion was logged; a draft created later read the conversation live after the message was gone. The sweep no
--     longer blanks by conversation (the FK cascade already removed those drafts inside P7a's purge).
drop function if exists public.exec_slack_rdraft_blank(text, text, text[], text[], text, timestamptz);
create or replace function public.exec_slack_rdraft_blank(p_principal text, p_channel text, p_ts text[], p_authors text[], p_reason text,
                                                          p_before timestamptz)
returns text[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids text[] := '{}';
  v_id  text;
  v_st  text;
begin
  if p_reason is null or p_reason not in ('deleted', 'author_optout', 'conversation', 'reading') then raise exception 'exec_slack_rdraft_blank: reason'; end if;
  if p_channel is null and p_authors is null then raise exception 'exec_slack_rdraft_blank: a channel or authors are required'; end if;
  if p_ts is not null and not public.exec_slack_ts_array_ok(p_ts) then raise exception 'exec_slack_rdraft_blank: ts'; end if;
  if p_authors is not null and not public.exec_slack_user_array_ok(p_authors) then raise exception 'exec_slack_rdraft_blank: authors'; end if;
  for v_id, v_st in
    select d.id, d.status from public.exec_slack_reply_drafts d
     where d.principal_id = p_principal and d.content_purged_at is null
       and (p_before is null or d.created_at <= p_before)
       and ((p_channel is not null and d.channel_id = p_channel
             and (p_ts is null or d.source_ts = any (p_ts) or d.context_ts && p_ts))
            or (p_authors is not null and d.context_authors && p_authors))
     order by d.id
     for update
  loop
    if v_st in ('generating', 'generation_failed', 'draft') then
      update public.exec_slack_reply_drafts
         set status = 'removed', status_reason = p_reason, terminal_at = now(), text = null, instruction = null, note = null,
             placeholders = '{}', content_purged_at = now(), expires_at = now() + interval '30 days', updated_at = now()
       where id = v_id;
    else
      update public.exec_slack_reply_drafts
         set text = null, instruction = null, note = null, placeholders = '{}', content_purged_at = now(), updated_at = now()
       where id = v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end;
$$;

-- 19. TTLs (C44), principal-agnostic (the system purge).
drop function if exists public.exec_slack_rdraft_purge_expired(timestamptz);
create or replace function public.exec_slack_rdraft_purge_expired(p_now timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_expired  integer;
  v_content  integer;
  v_unknown  integer;
  v_deleted  integer;
  v_cards    integer;
  v_voice    integer;
begin
  -- 1. Open drafts idle past expires_at → expired, content gone; the row lives 30 more days.
  update public.exec_slack_reply_drafts
     set status = 'expired', status_reason = 'idle', terminal_at = v_now, text = null, instruction = null, note = null,
         placeholders = '{}', content_purged_at = v_now, expires_at = v_now + interval '30 days', updated_at = now()
   where ctid in (select ctid from public.exec_slack_reply_drafts
                   where status in ('generating', 'generation_failed', 'draft') and expires_at < v_now limit 1000);
  get diagnostics v_expired = row_count;
  -- 2. Closed rows: content 7 days after the end; 3. unknown rows: content 7 days after sending_at.
  update public.exec_slack_reply_drafts
     set text = null, instruction = null, note = null, placeholders = '{}', content_purged_at = v_now, updated_at = now()
   where ctid in (select ctid from public.exec_slack_reply_drafts
                   where content_purged_at is null and status in ('sent', 'failed', 'discarded', 'expired', 'removed')
                     and terminal_at < v_now - interval '7 days' limit 1000);
  get diagnostics v_content = row_count;
  update public.exec_slack_reply_drafts
     set text = null, instruction = null, note = null, placeholders = '{}', content_purged_at = v_now, updated_at = now()
   where ctid in (select ctid from public.exec_slack_reply_drafts
                   where content_purged_at is null and status = 'unknown' and sending_at < v_now - interval '7 days' limit 1000);
  get diagnostics v_unknown = row_count;
  -- 4. Rows: 30 days after the end (unknown: after sending_at).
  delete from public.exec_slack_reply_drafts
   where ctid in (select ctid from public.exec_slack_reply_drafts
                   where (status in ('sent', 'failed', 'discarded', 'expired', 'removed') and terminal_at < v_now - interval '30 days')
                      or (status = 'unknown' and sending_at < v_now - interval '30 days')
                   limit 1000);
  get diagnostics v_deleted = row_count;
  -- 5. Cards (P6's DM purge deletes the Slack message on its own schedule) and 6. the voice profile.
  delete from public.exec_slack_reply_cards where expires_at < v_now;
  get diagnostics v_cards = row_count;
  delete from public.exec_slack_voice_profile where expires_at < v_now;
  get diagnostics v_voice = row_count;
  return jsonb_build_object('expired', v_expired, 'contentPurged', v_content + v_unknown, 'deleted', v_deleted, 'cards', v_cards,
                            'voice', v_voice);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. exec_slack_accept_action_v3: P8's exec_slack_accept_action_v2, versioned again (C38; H4)
-- ---------------------------------------------------------------------------
-- P8's exec_slack_accept_action_v2 (20261111100000_exec_brief.sql) and P6's exec_slack_accept_action are NOT touched. This is
-- v2's final body copied verbatim with exactly two changes: the action allow-list gains 'ea_sr_send', 'ea_sr_rewrite' and
-- 'ea_sr_discard', and the reply-draft branch below runs right after v2's check-in branch (before P6's insert). It is the
-- only SQL function that names the send job's kind (v1.1 security-3; the grid checks it): only a verified click starts a
-- DM send. The trigger id is used for the dedupe key only and is never stored anywhere else.

drop function if exists public.exec_slack_accept_action_v3(text, text, text, text, text, text, text, text, text);
create or replace function public.exec_slack_accept_action_v3(
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
  v_inst       public.exec_slack_installations%rowtype;
  v_job        bigint;
  v_checkin_id text;
  v_rev        integer;
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
                                                'ea_task_create', 'ea_task_dismiss', 'ea_fb_up', 'ea_fb_down',
                                                'ea_ci_send', 'ea_ci_rewrite',
                                                'ea_sr_send', 'ea_sr_rewrite', 'ea_sr_discard') then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'unknown_action');
  end if;
  if p_value is null or char_length(p_value) > 200 or p_value !~ '^[a-z][0-9]\.[A-Za-z0-9_.]+$' then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'bad_value');
  end if;
  if p_trigger_id is null or p_trigger_id !~ '^[A-Za-z0-9.]{1,200}$' then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'bad_trigger');
  end if;
  -- P8 (C43, M6, intel-17): check-in buttons. One job per CLICK (P6's trigger-id dedupe): Slack's retries of one click
  -- are duplicates, a second click is a new job. The handler's plain-row CAS keeps it to one post per row and rev, and a
  -- click after an early exit (audit unavailable, check-ins paused, a transient error) is never a dead button.
  if p_action_id in ('ea_ci_send', 'ea_ci_rewrite') then
    if p_value !~ '^c1\.ebc_[0-9a-f]{32}\.[0-9]{1,4}\.[0-9a-f]{32}$' then
      return jsonb_build_object('outcome', 'ignored', 'reason', 'bad_value');
    end if;
    v_checkin_id := split_part(p_value, '.', 2);
    v_rev := split_part(p_value, '.', 3)::integer;
    insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
    values (case when p_action_id = 'ea_ci_send' then 'exec.checkin-send' else 'exec.checkin-rewrite' end,
            'interactive', v_inst.principal_id,
            jsonb_build_object('installation_id', v_inst.id, 'checkin_id', v_checkin_id, 'rev', v_rev, 'value', p_value,
                               'channel_id', p_channel_id, 'message_ts', p_message_ts),
            (case when p_action_id = 'ea_ci_send' then 'checkin-send:' else 'checkin-rewrite:' end) || p_trigger_id,
            1)
    on conflict (dedupe_key) do nothing
    returning id into v_job;
    return jsonb_build_object('outcome', case when v_job is null then 'duplicate' else 'enqueued' end);
  end if;
  -- P10 (C32, C38): reply-draft buttons. One job per CLICK (trigger-id dedupe): Slack's retries of one click are duplicates,
  -- a second click is a new job. The send job's CAS keeps it to one post per draft and version.
  if p_action_id in ('ea_sr_send', 'ea_sr_rewrite', 'ea_sr_discard') then
    if p_value !~ '^r1\.esr_[0-9a-f]{32}\.[0-9]{1,4}\.[0-9a-f]{32}$' then
      return jsonb_build_object('outcome', 'ignored', 'reason', 'bad_value');
    end if;
    insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts)
    values (case when p_action_id = 'ea_sr_send' then 'exec.slack-rdraft-send' else 'exec.slack-rdraft-act' end,
            'interactive', v_inst.principal_id,
            jsonb_build_object('installation_id', v_inst.id,
                               'action', case p_action_id when 'ea_sr_send' then 'send' when 'ea_sr_rewrite' then 'rewrite' else 'discard' end,
                               'draft_id', split_part(p_value, '.', 2), 'version', split_part(p_value, '.', 3)::integer,
                               'value', p_value, 'channel_id', p_channel_id, 'message_ts', p_message_ts),
            (case when p_action_id = 'ea_sr_send' then 'srd-send:' else 'srd-act:' end) || p_trigger_id,
            1)
    on conflict (dedupe_key) do nothing
    returning id into v_job;
    return jsonb_build_object('outcome', case when v_job is null then 'duplicate' else 'enqueued' end);
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
-- 11. The brief's leads block (C23; P8's table, new functions; B-P10-1: named only by brief-store.ts)
-- ---------------------------------------------------------------------------

-- 21. Lead counts switched off: removes only `leads` from his stored briefs' content (every P8 CHECK stays true: the content
--     CHECK only requires an object).
drop function if exists public.exec_brief_strip_leads(text);
create or replace function public.exec_brief_strip_leads(p_principal text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.exec_briefs set content = content - 'leads', updated_at = now()
   where principal_id = p_principal and content is not null and content ? 'leads';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 22. v1.1 correctness-3: the system purge's second source of principals to re-check. Stop reading, a revoke and an uninstall
--     delete every channel row of the installation (exec_slack_purge_reading), so the lead rows cascade away before the
--     purge looks; his stored briefs still name him.
drop function if exists public.exec_brief_principals_with_leads(integer);
create or replace function public.exec_brief_principals_with_leads(p_limit integer)
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct b.principal_id
    from public.exec_briefs b
   where b.content is not null and b.content ? 'leads'
   order by b.principal_id
   limit greatest(1, least(coalesce(p_limit, 100), 1000));
$$;

-- ---------------------------------------------------------------------------
-- 12. Lockdown
-- ---------------------------------------------------------------------------

alter table public.exec_slack_lead_channels enable row level security;
alter table public.exec_slack_lead_counts   enable row level security;
alter table public.exec_slack_reply_drafts  enable row level security;
alter table public.exec_slack_reply_cards   enable row level security;
alter table public.exec_slack_voice_profile enable row level security;
revoke all on public.exec_slack_lead_channels, public.exec_slack_lead_counts, public.exec_slack_reply_drafts,
              public.exec_slack_reply_cards, public.exec_slack_voice_profile from public, anon, authenticated;
grant all on public.exec_slack_lead_channels, public.exec_slack_lead_counts, public.exec_slack_reply_drafts,
             public.exec_slack_reply_cards, public.exec_slack_voice_profile to service_role;

revoke all on function public.exec_slack_ts_array_ok(text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_user_array_ok(text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_ref_array_ok(text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_channel_array_ok(text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_fb_lead_channels_v2() from public, anon, authenticated;
revoke all on function public.exec_slack_lead_markers(text, text, text[], text[]) from public, anon, authenticated;
revoke all on function public.exec_slack_lead_map_apply(text, text, jsonb, boolean, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_lead_counts_put(text, text, text, date, jsonb, timestamptz, date, boolean) from public, anon, authenticated;
revoke all on function public.exec_slack_lead_summary(text, date, date) from public, anon, authenticated;
revoke all on function public.exec_slack_lead_coverage(text, date) from public, anon, authenticated;
revoke all on function public.exec_slack_lead_purge_principal(text) from public, anon, authenticated;
revoke all on function public.exec_slack_lead_purge_expired(timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_rdraft_create(text, text, text, text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.exec_slack_rdraft_regenerate(text, text, integer, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_rdraft_finish(text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.exec_slack_rdraft_edit(text, text, integer, text, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_rdraft_target(text, text) from public, anon, authenticated;
revoke all on function public.exec_slack_rdraft_blank(text, text, text[], text[], text, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_rdraft_purge_expired(timestamptz) from public, anon, authenticated;
revoke all on function public.exec_slack_accept_action_v3(text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.exec_brief_strip_leads(text) from public, anon, authenticated;
revoke all on function public.exec_brief_principals_with_leads(integer) from public, anon, authenticated;
grant execute on function public.exec_slack_ts_array_ok(text[]) to service_role;
grant execute on function public.exec_slack_user_array_ok(text[]) to service_role;
grant execute on function public.exec_slack_ref_array_ok(text[]) to service_role;
grant execute on function public.exec_slack_channel_array_ok(text[]) to service_role;
grant execute on function public.exec_slack_fb_lead_channels_v2() to service_role;
grant execute on function public.exec_slack_lead_markers(text, text, text[], text[]) to service_role;
grant execute on function public.exec_slack_lead_map_apply(text, text, jsonb, boolean, timestamptz, timestamptz) to service_role;
grant execute on function public.exec_slack_lead_counts_put(text, text, text, date, jsonb, timestamptz, date, boolean) to service_role;
grant execute on function public.exec_slack_lead_summary(text, date, date) to service_role;
grant execute on function public.exec_slack_lead_coverage(text, date) to service_role;
grant execute on function public.exec_slack_lead_purge_principal(text) to service_role;
grant execute on function public.exec_slack_lead_purge_expired(timestamptz) to service_role;
grant execute on function public.exec_slack_rdraft_create(text, text, text, text, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.exec_slack_rdraft_regenerate(text, text, integer, text, boolean, timestamptz) to service_role;
grant execute on function public.exec_slack_rdraft_finish(text, text, integer, jsonb) to service_role;
grant execute on function public.exec_slack_rdraft_edit(text, text, integer, text, text[], timestamptz) to service_role;
grant execute on function public.exec_slack_rdraft_target(text, text) to service_role;
grant execute on function public.exec_slack_rdraft_blank(text, text, text[], text[], text, timestamptz) to service_role;
grant execute on function public.exec_slack_rdraft_purge_expired(timestamptz) to service_role;
grant execute on function public.exec_slack_accept_action_v3(text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.exec_brief_strip_leads(text) to service_role;
grant execute on function public.exec_brief_principals_with_leads(integer) to service_role;

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
--   * the seven exec_settings columns (type, NOT NULL, default) and the cap CHECK;
--   * every column of the five new tables with type and nullability, and the
--     defaults the app relies on;
--   * every named CHECK, validated (by the words their definition must hold;
--     the destination CHECK names coalesce(source_thread_ts, source_ts), the
--     counts' TTL CHECK names 402);
--   * the primary keys and the foreign keys with their ON UPDATE / ON DELETE
--     actions (the cascades from P7a's channel and message rows);
--   * every index by its definition (the text after " USING ") and uniqueness:
--     the active-draft key is UNIQUE and partial, the index on the drafts'
--     message reference is NOT partial (v1.1 correctness-10);
--   * the twenty-two functions: SECURITY INVOKER with search_path pinned, one
--     signature each; the four CHECK helpers IMMUTABLE; the six readers STABLE;
--   * exec_slack_accept_action_v3's body holds the reply-draft branch AND P8's
--     check-in branch AND P6's own path, and it is the only function that names
--     the send job's kind (v1.1 security-3);
--   * earlier objects byte-for-byte present: md5 of pg_get_functiondef (carriage
--     returns removed) of P6's, P7a's, P8's and P9's functions P10 sits next to;
--     P6's ledger CHECKs and P7a's deny CHECK still there;
--   * what this file relies on from P2a, P6, P7a, P8 and DD, so a later re-apply
--     of an earlier phase that loses one turns a row false.
-- Re-run this grid after re-applying any earlier phase's file (§7.3 step 1).
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
  -- C1, C23, C25, C30, C52: the seven switches, NOT NULL with their defaults.
  select 'settings column: exec_settings.' || e.col, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('slack_read_all', 'boolean', 'false'),
    ('slack_lead_counts_enabled', 'boolean', 'false'),
    ('slack_replies_enabled', 'boolean', 'false'),
    ('slack_reply_send_enabled', 'boolean', 'false'),
    ('slack_reply_auto', 'boolean', 'false'),
    ('slack_reply_daily_cap_usd', 'numeric(10,2)', '1.50'),
    ('slack_voice_enabled', 'boolean', 'true')
  ) e(col, typ, def)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = e.typ and a.attnotnull and pg_get_expr(d.adbin, d.adrelid) is not distinct from e.def as ok,
           format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ' (no default)') as found
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = to_regclass('public.exec_settings') and a.attname = e.col and a.attnum > 0 and not a.attisdropped
  ) x on true
  union all
  select 'settings check: exec_settings_slack_reply_cap_check', coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (select 1) one
  left join lateral (
    select pc.convalidated and pg_get_constraintdef(pc.oid) ~ '\mslack_reply_daily_cap_usd\M' and pg_get_constraintdef(pc.oid) ~ '\m20\M' as ok,
           pg_get_constraintdef(pc.oid) as found
    from pg_constraint pc
    where pc.conrelid = to_regclass('public.exec_settings') and pc.contype = 'c' and pc.conname = 'exec_settings_slack_reply_cap_check'
  ) x on true
  union all
  select 'columns: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_slack_lead_channels'), ('exec_slack_lead_counts'), ('exec_slack_reply_drafts'), ('exec_slack_reply_cards'),
               ('exec_slack_voice_profile')) e(tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_slack_lead_channels', 1, 'principal_id', 'text', true),
      ('exec_slack_lead_channels', 2, 'channel_id', 'text', true),
      ('exec_slack_lead_channels', 3, 'installation_id', 'text', true),
      ('exec_slack_lead_channels', 4, 'kind', 'text', true),
      ('exec_slack_lead_channels', 5, 'link', 'text', true),
      ('exec_slack_lead_channels', 6, 'task_id', 'text', false),
      ('exec_slack_lead_channels', 7, 'client_id', 'text', false),
      ('exec_slack_lead_channels', 8, 'client_label', 'text', false),
      ('exec_slack_lead_channels', 9, 'counted_from', 'date', false),
      ('exec_slack_lead_channels', 10, 'final_through', 'date', false),
      ('exec_slack_lead_channels', 11, 'final_attempt_at', 'timestamp with time zone', false),
      ('exec_slack_lead_channels', 12, 'counted_at', 'timestamp with time zone', false),
      ('exec_slack_lead_channels', 13, 'last_error_code', 'text', false),
      ('exec_slack_lead_channels', 14, 'mapped_at', 'timestamp with time zone', true),
      ('exec_slack_lead_channels', 15, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_lead_channels', 16, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_lead_channels', 17, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_lead_counts', 1, 'principal_id', 'text', true),
      ('exec_slack_lead_counts', 2, 'channel_id', 'text', true),
      ('exec_slack_lead_counts', 3, 'local_day', 'date', true),
      ('exec_slack_lead_counts', 4, 'tz', 'text', true),
      ('exec_slack_lead_counts', 5, 'n', 'integer', true),
      ('exec_slack_lead_counts', 6, 'skipped', 'integer', true),
      ('exec_slack_lead_counts', 7, 'complete', 'boolean', true),
      ('exec_slack_lead_counts', 8, 'counted_at', 'timestamp with time zone', true),
      ('exec_slack_lead_counts', 9, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_reply_drafts', 1, 'id', 'text', true),
      ('exec_slack_reply_drafts', 2, 'principal_id', 'text', true),
      ('exec_slack_reply_drafts', 3, 'installation_id', 'text', true),
      ('exec_slack_reply_drafts', 4, 'channel_id', 'text', true),
      ('exec_slack_reply_drafts', 5, 'conv_type', 'text', true),
      ('exec_slack_reply_drafts', 6, 'item_id', 'text', false),
      ('exec_slack_reply_drafts', 7, 'source_ts', 'text', true),
      ('exec_slack_reply_drafts', 8, 'source_thread_ts', 'text', false),
      ('exec_slack_reply_drafts', 9, 'reply_thread_ts', 'text', false),
      ('exec_slack_reply_drafts', 10, 'origin', 'text', true),
      ('exec_slack_reply_drafts', 11, 'status', 'text', true),
      ('exec_slack_reply_drafts', 12, 'status_reason', 'text', false),
      ('exec_slack_reply_drafts', 13, 'version', 'integer', true),
      ('exec_slack_reply_drafts', 14, 'generation_seq', 'integer', true),
      ('exec_slack_reply_drafts', 15, 'text', 'text', false),
      ('exec_slack_reply_drafts', 16, 'instruction', 'text', false),
      ('exec_slack_reply_drafts', 17, 'note', 'text', false),
      ('exec_slack_reply_drafts', 18, 'placeholders', 'text[]', true),
      ('exec_slack_reply_drafts', 19, 'edited', 'boolean', true),
      ('exec_slack_reply_drafts', 20, 'flags', 'text[]', true),
      ('exec_slack_reply_drafts', 21, 'injection_suspected', 'boolean', true),
      ('exec_slack_reply_drafts', 22, 'voice_source', 'text', false),
      ('exec_slack_reply_drafts', 23, 'model', 'text', false),
      ('exec_slack_reply_drafts', 24, 'generation_error', 'text', false),
      ('exec_slack_reply_drafts', 25, 'context_ts', 'text[]', true),
      ('exec_slack_reply_drafts', 26, 'context_authors', 'text[]', true),
      ('exec_slack_reply_drafts', 27, 'context_latest_ts', 'text', false),
      ('exec_slack_reply_drafts', 28, 'source_edited_ts', 'text', false),
      ('exec_slack_reply_drafts', 29, 'external', 'boolean', true),
      ('exec_slack_reply_drafts', 30, 'finance', 'boolean', true),
      ('exec_slack_reply_drafts', 31, 'generated_at', 'timestamp with time zone', false),
      ('exec_slack_reply_drafts', 32, 'sending_at', 'timestamp with time zone', false),
      ('exec_slack_reply_drafts', 33, 'audit_id', 'bigint', false),
      ('exec_slack_reply_drafts', 34, 'sent_at', 'timestamp with time zone', false),
      ('exec_slack_reply_drafts', 35, 'posted_ts', 'text', false),
      ('exec_slack_reply_drafts', 36, 'posted_permalink', 'text', false),
      ('exec_slack_reply_drafts', 37, 'sent_text_sha256', 'text', false),
      ('exec_slack_reply_drafts', 38, 'sent_words_sha256', 'text', false),
      ('exec_slack_reply_drafts', 39, 'verify_checks', 'smallint', true),
      ('exec_slack_reply_drafts', 40, 'owner_resolution', 'text', false),
      ('exec_slack_reply_drafts', 41, 'chat_message_id', 'text', false),
      ('exec_slack_reply_drafts', 42, 'terminal_at', 'timestamp with time zone', false),
      ('exec_slack_reply_drafts', 43, 'content_purged_at', 'timestamp with time zone', false),
      ('exec_slack_reply_drafts', 44, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_reply_drafts', 45, 'created_at', 'timestamp with time zone', true),
      ('exec_slack_reply_drafts', 46, 'updated_at', 'timestamp with time zone', true),
      ('exec_slack_reply_cards', 1, 'installation_id', 'text', true),
      ('exec_slack_reply_cards', 2, 'principal_id', 'text', true),
      ('exec_slack_reply_cards', 3, 'dm_channel_id', 'text', true),
      ('exec_slack_reply_cards', 4, 'dm_ts', 'text', true),
      ('exec_slack_reply_cards', 5, 'thread_ts', 'text', false),
      ('exec_slack_reply_cards', 6, 'draft_id', 'text', true),
      ('exec_slack_reply_cards', 7, 'origin', 'text', true),
      ('exec_slack_reply_cards', 8, 'rendered_version', 'integer', true),
      ('exec_slack_reply_cards', 9, 'rendered_state', 'text', true),
      ('exec_slack_reply_cards', 10, 'posted_at', 'timestamp with time zone', true),
      ('exec_slack_reply_cards', 11, 'followed_at', 'timestamp with time zone', false),
      ('exec_slack_reply_cards', 12, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_voice_profile', 1, 'principal_id', 'text', true),
      ('exec_slack_voice_profile', 2, 'status', 'text', true),
      ('exec_slack_voice_profile', 3, 'formality', 'text', false),
      ('exec_slack_voice_profile', 4, 'typical_length', 'text', false),
      ('exec_slack_voice_profile', 5, 'capitalization', 'text', false),
      ('exec_slack_voice_profile', 6, 'punctuation', 'text', false),
      ('exec_slack_voice_profile', 7, 'greeting', 'text', false),
      ('exec_slack_voice_profile', 8, 'emoji', 'text', false),
      ('exec_slack_voice_profile', 9, 'abbreviations', 'text', false),
      ('exec_slack_voice_profile', 10, 'exclamations', 'text', false),
      ('exec_slack_voice_profile', 11, 'bullets', 'text', false),
      ('exec_slack_voice_profile', 12, 'sample_count', 'integer', true),
      ('exec_slack_voice_profile', 13, 'sample_refs', 'text[]', true),
      ('exec_slack_voice_profile', 14, 'sample_channels', 'text[]', true),
      ('exec_slack_voice_profile', 15, 'samples_hash', 'text', false),
      ('exec_slack_voice_profile', 16, 'model', 'text', false),
      ('exec_slack_voice_profile', 17, 'prompt_version', 'text', true),
      ('exec_slack_voice_profile', 18, 'last_attempt_error', 'text', false),
      ('exec_slack_voice_profile', 19, 'built_at', 'timestamp with time zone', true),
      ('exec_slack_voice_profile', 20, 'expires_at', 'timestamp with time zone', true),
      ('exec_slack_voice_profile', 21, 'updated_at', 'timestamp with time zone', true)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select 'defaults: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_slack_lead_channels'), ('exec_slack_lead_counts'), ('exec_slack_reply_drafts'), ('exec_slack_reply_cards'),
               ('exec_slack_voice_profile')) e(tbl)
  cross join lateral (
    select string_agg(k.col || ' default ' || k.def, ', ' order by k.col) as wrong
    from (values
      ('exec_slack_lead_channels', 'created_at', 'now()'),
      ('exec_slack_lead_channels', 'updated_at', 'now()'),
      ('exec_slack_lead_counts', 'skipped', '0'),
      ('exec_slack_reply_drafts', 'id', '(''esr_''::text || replace((gen_random_uuid())::text, ''-''::text, ''''::text))'),
      ('exec_slack_reply_drafts', 'status', '''generating''::text'),
      ('exec_slack_reply_drafts', 'version', '0'),
      ('exec_slack_reply_drafts', 'generation_seq', '1'),
      ('exec_slack_reply_drafts', 'placeholders', '''{}''::text[]'),
      ('exec_slack_reply_drafts', 'edited', 'false'),
      ('exec_slack_reply_drafts', 'flags', '''{}''::text[]'),
      ('exec_slack_reply_drafts', 'injection_suspected', 'false'),
      ('exec_slack_reply_drafts', 'context_ts', '''{}''::text[]'),
      ('exec_slack_reply_drafts', 'context_authors', '''{}''::text[]'),
      ('exec_slack_reply_drafts', 'verify_checks', '0'),
      ('exec_slack_reply_drafts', 'created_at', 'now()'),
      ('exec_slack_reply_drafts', 'updated_at', 'now()'),
      ('exec_slack_reply_cards', 'posted_at', 'now()'),
      ('exec_slack_voice_profile', 'sample_count', '0'),
      ('exec_slack_voice_profile', 'sample_refs', '''{}''::text[]'),
      ('exec_slack_voice_profile', 'sample_channels', '''{}''::text[]'),
      ('exec_slack_voice_profile', 'updated_at', 'now()')
    ) k(tbl, col, def)
    where k.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = k.col and not a.attisdropped
          and pg_get_expr(d.adbin, d.adrelid) = k.def)
  ) x
  union all
  select 'checks: ' || e.tbl, x.missing is null, x.missing
  from (values ('exec_slack_lead_channels'), ('exec_slack_lead_counts'), ('exec_slack_reply_drafts'), ('exec_slack_reply_cards'),
               ('exec_slack_voice_profile')) e(tbl)
  cross join lateral (
    select string_agg(k.name || case when d.def is null then '' when not d.valid then ' (not validated)' else ' (definition)' end,
                      ', ' order by k.name) as missing
    from (values
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_id_check', array['channel_id']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_kind_check', array['vob', 'nonvob', 'calendly', 'zap_errors', 'other']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_link_check', array['fb_id', 'fb_name', 'fb_sibling', 'ambiguous', 'none']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_task_check', array['task_id', '64']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_client_check', array['client_id', '64']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_label_check', array['client_label', '120']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_error_check', array['last_error_code']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_link_pair_check', array['link', 'task_id', 'client_label']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_client_pair_check', array['client_id', 'task_id']),
      ('exec_slack_lead_channels', 'exec_slack_lead_channels_expiry_check', array['expires_at', 'mapped_at', '401 days']),
      ('exec_slack_lead_counts', 'exec_slack_lead_counts_tz_check', array['tz', '64']),
      ('exec_slack_lead_counts', 'exec_slack_lead_counts_n_check', array['n', '100000']),
      ('exec_slack_lead_counts', 'exec_slack_lead_counts_skipped_check', array['skipped', '100000']),
      ('exec_slack_lead_counts', 'exec_slack_lead_counts_ttl_check', array['expires_at', 'counted_at', 'local_day', '402']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_id_check', array['id', 'esr_']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_channel_check', array['channel_id']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_conv_check', array['channel', 'group', 'im', 'mpim']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_item_check', array['item_id', 'esl_']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_source_ts_check', array['source_ts']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_source_thread_check', array['source_thread_ts', 'source_ts']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_reply_thread_check', array['reply_thread_ts']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_origin_check', array['web', 'chat', 'slack', 'auto']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_status_check',
       array['generating', 'generation_failed', 'draft', 'sending', 'sent', 'unknown', 'failed', 'discarded', 'expired', 'removed']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_reason_check', array['status_reason']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_version_check', array['version', '9999']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_seq_check', array['generation_seq', '1000']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_text_check', array['text', '4000']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_instruction_check', array['instruction', '2000']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_note_check', array['note', '400']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_placeholders_check', array['placeholders', '20']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_flags_check',
       array['unexpected_url', 'unexpected_email', 'unexpected_phone', 'unexpected_amount', 'unexpected_number', 'mention', 'broadcast']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_voice_check', array['slack', 'email', 'house']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_model_check', array['model', '64']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_generror_check',
       array['refused', 'truncated', 'invalid_output', 'empty', 'too_long', 'copied_external', 'timeout', 'model_error', 'budget',
             'context_unavailable', 'reading_off', 'channel', 'context_deleted', 'author_optout']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_context_ts_check', array['context_ts', '80', 'exec_slack_ts_array_ok']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_context_authors_check', array['context_authors', '80', 'exec_slack_user_array_ok']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_latest_check', array['context_latest_ts']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_edited_check', array['source_edited_ts']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_posted_check', array['posted_ts']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_permalink_check', array['posted_permalink', '500']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_sha_check', array['sent_text_sha256']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_words_check', array['sent_words_sha256']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_verify_check', array['verify_checks', '3']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_resolution_check', array['posted', 'not_posted']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_chat_check', array['chat_message_id', 'ecm_']),
      -- C28: the destination is the source's own thread, and only that.
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_destination_check',
       array['coalesce(source_thread_ts, source_ts)', 'reply_thread_ts', 'channel', 'group', 'im', 'mpim']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_text_presence_check', array['draft', 'text']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_version_presence_check',
       array['draft', 'sending', 'sent', 'unknown', 'failed', 'version']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_terminal_check',
       array['sent', 'failed', 'discarded', 'expired', 'removed', 'terminal_at']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_sent_check', array['sent', 'sent_at']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_sent_refs_check', array['sent', 'posted_ts', 'owner_resolution', 'posted']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_sending_check', array['sending', 'sent', 'unknown', 'sending_at', 'audit_id']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_resolution_pair_check',
       array['owner_resolution', 'posted', 'not_posted', 'sent', 'failed']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_generation_check', array['generation_failed', 'generation_error']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_content_check',
       array['content_purged_at', 'text', 'instruction', 'note', 'placeholders']),
      ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_expiry_check', array['expires_at', 'created_at']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_channel_check', array['dm_channel_id']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_ts_check', array['dm_ts']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_thread_check', array['thread_ts']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_draft_check', array['draft_id', 'esr_']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_origin_check', array['slack', 'auto']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_version_check', array['rendered_version', '9999']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_state_check',
       array['generating', 'failed_generation', 'live', 'dd_only', 'sending', 'sent', 'unknown', 'failed', 'discarded', 'expired', 'removed', 'off']),
      ('exec_slack_reply_cards', 'exec_slack_reply_cards_expiry_check', array['expires_at', 'posted_at']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_status_check', array['ready', 'insufficient', 'failed']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_formality_check', array['very_casual', 'casual', 'neutral', 'formal']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_length_check', array['one_liner', 'short', 'medium', 'long']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_caps_check', array['mostly_lowercase', 'standard']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_punct_check', array['minimal', 'standard']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_greeting_check', array['none', 'name_only', 'hey_name', 'hi_name', 'mixed']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_emoji_check', array['never', 'rarely', 'sometimes', 'often']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_abbrev_check', array['never', 'sometimes', 'often']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_excl_check', array['never', 'sometimes', 'often']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_bullets_check', array['never', 'sometimes', 'often']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_count_check', array['sample_count', '60']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_refs_check', array['sample_refs', '60', 'exec_slack_ref_array_ok']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_channels_check', array['sample_channels', '10', 'exec_slack_channel_array_ok']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_hash_check', array['samples_hash']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_model_check', array['model', '64']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_prompt_check', array['prompt_version', '40']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_error_check',
       array['declined', 'truncated', 'invalid_output', 'budget', 'read_failed', 'insufficient']),
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_ready_check',
       array['ready', 'formality', 'typical_length', 'capitalization', 'punctuation', 'greeting', 'emoji', 'abbreviations', 'exclamations', 'bullets']),
      -- v1.1 correctness-4: the expiry never more than 31 days after built_at (an "unchanged" refresh moves both).
      ('exec_slack_voice_profile', 'exec_slack_voice_profile_expiry_check', array['expires_at', 'built_at', '31 days'])
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
                  where case when w ~ '^[A-Za-z0-9_:.]+$' then d.def !~ ('\m' || w || '\M') else strpos(lower(d.def), lower(w)) = 0 end)))
  ) x
  union all
  select e.label, coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('primary key: exec_slack_lead_channels', 'exec_slack_lead_channels', 'exec_slack_lead_channels_pkey', array['principal_id', 'channel_id']),
    ('primary key: exec_slack_lead_counts', 'exec_slack_lead_counts', 'exec_slack_lead_counts_pkey', array['principal_id', 'channel_id', 'local_day']),
    ('primary key: exec_slack_reply_drafts', 'exec_slack_reply_drafts', 'exec_slack_reply_drafts_pkey', array['id']),
    ('primary key: exec_slack_reply_cards', 'exec_slack_reply_cards', 'exec_slack_reply_cards_pkey', array['installation_id', 'dm_ts']),
    ('primary key: exec_slack_voice_profile', 'exec_slack_voice_profile', 'exec_slack_voice_profile_pkey', array['principal_id'])
  ) e(label, tbl, name, cols)
  left join lateral (
    select k.contype::text = 'p' and c.cols = e.cols as ok,
           k.contype::text || ' (' || array_to_string(c.cols, ', ') || ')' as found
    from pg_constraint k
    cross join lateral (
      select array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                   order by u.ord) as cols) c
    where k.conrelid = to_regclass('public.' || e.tbl) and k.conname = e.name
  ) x on true
  union all
  -- Matched by columns (the inline references are auto-named): the table's FK on exactly these columns, with its actions
  -- (c = cascade, a = no action). The two cascades from P7a's rows carry ON UPDATE CASCADE too (a re-key moves them).
  select 'FK: ' || e.tbl || ' (' || array_to_string(e.cols, ', ') || ') -> ' || e.ref
           || case when e.upd = 'c' then ' on update cascade' else '' end || ' on delete cascade',
         coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_slack_lead_channels', array['principal_id', 'channel_id'], 'exec_slack_channels', array['principal_id', 'channel_id'], 'c'),
    ('exec_slack_lead_channels', array['installation_id'], 'exec_slack_installations', array['id'], 'a'),
    ('exec_slack_lead_counts', array['principal_id', 'channel_id'], 'exec_slack_lead_channels', array['principal_id', 'channel_id'], 'c'),
    ('exec_slack_reply_drafts', array['principal_id', 'channel_id', 'source_ts'], 'exec_slack_messages', array['principal_id', 'channel_id', 'ts'], 'c'),
    ('exec_slack_reply_drafts', array['installation_id'], 'exec_slack_installations', array['id'], 'a'),
    ('exec_slack_reply_cards', array['installation_id'], 'exec_slack_installations', array['id'], 'a'),
    ('exec_slack_reply_cards', array['principal_id'], 'exec_principals', array['id'], 'a'),
    ('exec_slack_voice_profile', array['principal_id'], 'exec_principals', array['id'], 'a')
  ) e(tbl, cols, ref, refcols, upd)
  left join lateral (
    select bool_or(k.confrelid = to_regclass('public.' || e.ref) and k.confdeltype = 'c' and k.confupdtype::text = e.upd
                   and c.refcols = e.refcols) as ok,
           string_agg('references ' || k.confrelid::regclass::text || ' (' || array_to_string(c.refcols, ', ') || ') on update '
                      || k.confupdtype::text || ' on delete ' || k.confdeltype::text, '; ') as found
    from pg_constraint k
    cross join lateral (
      select array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord) as cols,
             array(select a.attname::text from unnest(k.confkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum order by u.ord) as refcols) c
    where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'f' and c.cols = e.cols
  ) x on true
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def and x.uniq = e.uniq, false),
         case when not coalesce(x.def = e.def and x.uniq = e.uniq, false)
              then coalesce(case when x.uniq then 'unique ' else '' end || x.def, '(missing)') end
  from (values
    ('exec_slack_lead_channels', 'exec_slack_lead_channels_installation_idx', 'btree (installation_id)', false),
    ('exec_slack_lead_channels', 'exec_slack_lead_channels_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_lead_channels', 'exec_slack_lead_channels_due_idx', 'btree (principal_id, counted_at NULLS FIRST)', false),
    ('exec_slack_lead_counts', 'exec_slack_lead_counts_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_lead_counts', 'exec_slack_lead_counts_day_idx', 'btree (principal_id, local_day)', false),
    -- C45: one active draft per message.
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_active_key',
     'btree (principal_id, channel_id, source_ts) WHERE (status = ANY (ARRAY[''generating''::text, ''generation_failed''::text, ''draft''::text, ''sending''::text, ''unknown''::text]))',
     true),
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_list_idx', 'btree (principal_id, status, updated_at DESC)', false),
    -- v1.1 correctness-10: the FK's own columns, no WHERE (the cascade query of P7a's message deletes uses it).
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_message_idx', 'btree (principal_id, channel_id, source_ts)', false),
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_context_ts_gin', 'gin (context_ts)', false),
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_context_authors_gin', 'gin (context_authors)', false),
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_posted_idx', 'btree (principal_id, posted_ts) WHERE (posted_ts IS NOT NULL)', false),
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_inflight_idx',
     'btree (principal_id, sending_at) WHERE (status = ANY (ARRAY[''sending''::text, ''unknown''::text]))', false),
    ('exec_slack_reply_drafts', 'exec_slack_reply_drafts_installation_idx', 'btree (installation_id)', false),
    ('exec_slack_reply_cards', 'exec_slack_reply_cards_draft_idx', 'btree (principal_id, draft_id)', false),
    ('exec_slack_reply_cards', 'exec_slack_reply_cards_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_reply_cards', 'exec_slack_reply_cards_open_idx',
     'btree (principal_id) WHERE (rendered_state <> ALL (ARRAY[''sent''::text, ''failed''::text, ''discarded''::text, ''expired''::text, ''removed''::text, ''off''::text]))',
     false),
    ('exec_slack_voice_profile', 'exec_slack_voice_profile_expires_idx', 'btree (expires_at)', false),
    ('exec_slack_voice_profile', 'exec_slack_voice_profile_refs_gin', 'gin (sample_refs)', false)
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
    ('exec_slack_ts_array_ok(text[])'),
    ('exec_slack_user_array_ok(text[])'),
    ('exec_slack_ref_array_ok(text[])'),
    ('exec_slack_channel_array_ok(text[])'),
    ('exec_slack_fb_lead_channels_v2()'),
    ('exec_slack_lead_markers(text,text,text[],text[])'),
    ('exec_slack_lead_map_apply(text,text,jsonb,boolean,timestamptz,timestamptz)'),
    ('exec_slack_lead_counts_put(text,text,text,date,jsonb,timestamptz,date,boolean)'),
    ('exec_slack_lead_summary(text,date,date)'),
    ('exec_slack_lead_coverage(text,date)'),
    ('exec_slack_lead_purge_principal(text)'),
    ('exec_slack_lead_purge_expired(timestamptz)'),
    ('exec_slack_rdraft_create(text,text,text,text,text,text,text,text,text,timestamptz)'),
    ('exec_slack_rdraft_regenerate(text,text,integer,text,boolean,timestamptz)'),
    ('exec_slack_rdraft_finish(text,text,integer,jsonb)'),
    ('exec_slack_rdraft_edit(text,text,integer,text,text[],timestamptz)'),
    ('exec_slack_rdraft_target(text,text)'),
    ('exec_slack_rdraft_blank(text,text,text[],text[],text,timestamptz)'),
    ('exec_slack_rdraft_purge_expired(timestamptz)'),
    ('exec_slack_accept_action_v3(text,text,text,text,text,text,text,text,text)'),
    ('exec_brief_strip_leads(text)'),
    ('exec_brief_principals_with_leads(integer)')
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
  from (values ('exec_slack_ts_array_ok'), ('exec_slack_user_array_ok'), ('exec_slack_ref_array_ok'), ('exec_slack_channel_array_ok'),
               ('exec_slack_fb_lead_channels_v2'), ('exec_slack_lead_markers'), ('exec_slack_lead_map_apply'), ('exec_slack_lead_counts_put'),
               ('exec_slack_lead_summary'), ('exec_slack_lead_coverage'), ('exec_slack_lead_purge_principal'), ('exec_slack_lead_purge_expired'),
               ('exec_slack_rdraft_create'), ('exec_slack_rdraft_regenerate'), ('exec_slack_rdraft_finish'), ('exec_slack_rdraft_edit'),
               ('exec_slack_rdraft_target'), ('exec_slack_rdraft_blank'), ('exec_slack_rdraft_purge_expired'), ('exec_slack_accept_action_v3'),
               ('exec_brief_strip_leads'), ('exec_brief_principals_with_leads')) e(name)
  cross join lateral (
    select count(*)::int as n, string_agg(p.oid::regprocedure::text, '; ') as sigs
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = e.name
  ) x
  union all
  select e.vol_label || ': ' || e.fn, coalesce(x.vol = e.vol, false),
         case when not coalesce(x.vol = e.vol, false) then coalesce('provolatile ' || x.vol, '(missing)') end
  from (values
    ('immutable', 'i', 'exec_slack_ts_array_ok(text[])'),
    ('immutable', 'i', 'exec_slack_user_array_ok(text[])'),
    ('immutable', 'i', 'exec_slack_ref_array_ok(text[])'),
    ('immutable', 'i', 'exec_slack_channel_array_ok(text[])'),
    ('stable', 's', 'exec_slack_fb_lead_channels_v2()'),
    ('stable', 's', 'exec_slack_lead_markers(text,text,text[],text[])'),
    ('stable', 's', 'exec_slack_lead_summary(text,date,date)'),
    ('stable', 's', 'exec_slack_lead_coverage(text,date)'),
    ('stable', 's', 'exec_slack_rdraft_target(text,text)'),
    ('stable', 's', 'exec_brief_principals_with_leads(integer)')
  ) e(vol_label, vol, fn)
  left join lateral (select p.provolatile::text as vol from pg_proc p where p.oid = to_regprocedure('public.' || e.fn)) x on true
  union all
  -- C38 / H4: v3 holds the reply-draft branch (one job per click, the send kind, the value shape) AND P8's check-in branch AND
  -- P6's own path (both survived the copy).
  select 'reply-draft branch and earlier paths (C38): exec_slack_accept_action_v3', coalesce(x.missing is null and x.found, false),
         case when not coalesce(x.missing is null and x.found, false) then coalesce('prosrc lacks: ' || x.missing, '(missing)') end
  from (select 1) one
  left join lateral (
    select true as found,
           (select string_agg(w, ', ') from unnest(array[
              '''ea_sr_send''', '''ea_sr_rewrite''', '''ea_sr_discard''', '''exec.slack-rdraft-send''', '''exec.slack-rdraft-act''',
              '''srd-send:'' else ''srd-act:'' end) || p_trigger_id', '''^r1\.esr_[0-9a-f]{32}\.[0-9]{1,4}\.[0-9a-f]{32}$''',
              '''ea_ci_send''', '''exec.checkin-send''', '''checkin-send:'' else ''checkin-rewrite:'' end) || p_trigger_id',
              '''exec.slack-action''', '''slack-act:'' || p_trigger_id', '''ea_draft_save''', '''ea_fb_down''']) w
             where strpos(p.prosrc, w) = 0) as missing
    from pg_proc p where p.oid = to_regprocedure('public.exec_slack_accept_action_v3(text,text,text,text,text,text,text,text,text)')
  ) x on true
  union all
  -- v1.1 security-3 (B-P10-14): only a verified click starts a DM send; no other function in public names the send kind.
  select 'only v3 names the send kind (B-P10-14): exec.slack-rdraft-send', x.others = 0,
         case when x.others <> 0 then x.names end
  from (
    select count(*)::int as others, string_agg(p.oid::regprocedure::text, '; ') as names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname <> 'exec_slack_accept_action_v3' and p.prosrc like '%exec.slack-rdraft-send%'
  ) x
  union all
  -- H4: the earlier functions P10 sits next to are byte-for-byte the ones their phases applied (md5 of pg_get_functiondef with
  -- carriage returns removed, so the line endings the file was pasted with don't matter). A missing one fails too.
  select 'unchanged (' || e.phase || '): ' || e.label, coalesce(x.h = e.h, false),
         case when not coalesce(x.h = e.h, false) then coalesce('definition differs (md5 ' || x.h || ')', '(missing)') end
  from (values
    ('P6', 'exec_slack_accept_action(text x 9)', 'exec_slack_accept_action(text,text,text,text,text,text,text,text,text)',
     'efc78938fd03c0be40707379ec8c9969'),
    ('P7a', 'exec_slack_fb_lead_channels()', 'exec_slack_fb_lead_channels()', 'c6cb2015c5d6eac9a9906fc9ef0475b7'),
    ('P7a', 'exec_slack_apply_classes(text,text,jsonb,timestamptz)', 'exec_slack_apply_classes(text,text,jsonb,timestamptz)',
     '7fc004339b4cff2c267c09a8d56c532c'),
    ('P7a', 'exec_slack_purge_reading(text)', 'exec_slack_purge_reading(text)', '2ab02e347eb43f3c461af4719daff471'),
    ('P7a', 'exec_slack_accept_event_v2(21 arguments)',
     'exec_slack_accept_event_v2(text,text,text,text,bigint,integer,text,text,text,text,text,boolean,boolean,text,boolean,boolean,boolean,text,text[],text[],jsonb)',
     'eee12bc5f7a2f3a4dd94586e3bb25d4d'),
    ('P8', 'exec_slack_accept_action_v2(text x 9)', 'exec_slack_accept_action_v2(text,text,text,text,text,text,text,text,text)',
     '1cc740590c242760a838323aa0e02e2a'),
    ('P9', 'exec_brief_purge_expired_v2(timestamptz,integer,date)', 'exec_brief_purge_expired_v2(timestamptz,integer,date)',
     '0f5174a8f9dcab9707c0c97584bb54da'),
    ('P9', 'exec_brief_scrub_threads_v2(text,text[])', 'exec_brief_scrub_threads_v2(text,text[])', '4a7ce1727f5e157d6fff3acb8822f0b9'),
    ('P9', 'exec_brief_scrub_slack_v2(text,text[],text[],boolean)', 'exec_brief_scrub_slack_v2(text,text[],text[],boolean)',
     '390bbde4e291e52a24f253b73a68722d')
  ) e(phase, label, fn, h)
  left join lateral (
    select md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h
    from pg_proc p where p.oid = to_regprocedure('public.' || e.fn)
  ) x on true
  union all
  -- AM-P8-2 (kept by P10): P6's ledger CHECKs keep P6's kinds and ref shapes; a reply card is a 'note' row.
  select 'P6''s ledger CHECKs untouched: exec_slack_posts', coalesce(x.bad is null and x.n = 4, false),
         case when not coalesce(x.bad is null and x.n = 4, false) then coalesce(x.bad, x.n::text || ' of the 4 CHECKs present') end
  from (select 1) one
  left join lateral (
    select count(*)::int as n,
           string_agg(case
             when pc.conname = 'exec_slack_posts_kind_check'
                  and (pg_get_constraintdef(pc.oid) !~ '\manswer\M' or pg_get_constraintdef(pc.oid) !~ '\mnote\M'
                       or pg_get_constraintdef(pc.oid) !~ '\mdraft\M' or pg_get_constraintdef(pc.oid) !~ '\mproposal\M'
                       or pg_get_constraintdef(pc.oid) ~ '\m(brief|checkins|reply|reply_card)\M')
               then pc.conname || ': ' || pg_get_constraintdef(pc.oid)
             when pc.conname = 'exec_slack_posts_ref_shape_check' and strpos(pg_get_constraintdef(pc.oid), '^(ed|etp)_') = 0
               then pc.conname || ': ' || pg_get_constraintdef(pc.oid)
             when pc.conname in ('exec_slack_posts_ref_check', 'exec_slack_posts_ref_kind_check')
                  and pg_get_constraintdef(pc.oid) ~ '\m(brief|checkins|eb_|esr_)\M'
               then pc.conname || ': ' || pg_get_constraintdef(pc.oid)
           end, '; ') as bad
    from pg_constraint pc
    where pc.conrelid = to_regclass('public.exec_slack_posts') and pc.contype = 'c'
      and pc.conname in ('exec_slack_posts_kind_check', 'exec_slack_posts_ref_shape_check', 'exec_slack_posts_ref_check',
                         'exec_slack_posts_ref_kind_check')
  ) x on true
  union all
  -- N1: P7a's bare deny marker (the lead rows' parent) is still a bare marker.
  select 'still present (P7a): exec_slack_channels_deny_check', coalesce(x.ok, false), case when not coalesce(x.ok, false) then '(missing)' end
  from (select 1) one
  left join lateral (
    select pc.convalidated as ok from pg_constraint pc
     where pc.conrelid = to_regclass('public.exec_slack_channels') and pc.contype = 'c' and pc.conname = 'exec_slack_channels_deny_check'
  ) x on true
  union all
  select 'relies on (' || e.phase || '): column ' || e.tbl || '.' || e.col, x.typ is not null,
         case when x.typ is null then '(missing)' end
  from (values
    ('P2a', 'exec_jobs', 'dedupe_key'),
    ('P6', 'exec_slack_installations', 'principal_id'), ('P6', 'exec_slack_installations', 'team_id'),
    ('P6', 'exec_slack_installations', 'app_id'), ('P6', 'exec_slack_installations', 'user_id'),
    ('P6', 'exec_slack_installations', 'slack_dm_channel_id'), ('P6', 'exec_slack_installations', 'installed_at'),
    ('P6', 'exec_slack_installations', 'revoked_at'),
    ('P7a', 'exec_slack_installations', 'user_token_enc'), ('P7a', 'exec_slack_installations', 'reading_state'),
    ('P7a', 'exec_settings', 'slack_reading_enabled'),
    ('P7a', 'exec_slack_channels', 'installation_id'), ('P7a', 'exec_slack_channels', 'conv_type'),
    ('P7a', 'exec_slack_channels', 'class'), ('P7a', 'exec_slack_channels', 'deny_reason'),
    ('P7a', 'exec_slack_channels', 'name'), ('P7a', 'exec_slack_channels', 'finance_name'),
    ('P7a', 'exec_slack_channels', 'is_member'), ('P7a', 'exec_slack_channels', 'is_ext_shared'),
    ('P7a', 'exec_slack_channels', 'ext_ever'), ('P7a', 'exec_slack_channels', 'left_at'),
    ('P7a', 'exec_slack_messages', 'thread_ts'), ('P7a', 'exec_slack_messages', 'role'),
    ('P7a', 'exec_slack_messages', 'author_user_id'), ('P7a', 'exec_slack_messages', 'author_external'),
    ('P7a', 'exec_slack_messages', 'edited_ts'), ('P7a', 'exec_slack_messages', 'responded_at'),
    ('P7a', 'exec_slack_items', 'responded_at'), ('P7a', 'exec_slack_items', 'urgency'),
    ('P7a', 'exec_slack_deleted', 'ts'), ('P7a', 'exec_slack_author_optouts', 'author_user_id'),
    ('P8', 'exec_briefs', 'content'), ('P8', 'exec_briefs', 'updated_at'),
    ('DD', 'fb_onboarding', 'task_id'), ('DD', 'fb_onboarding', 'state'),
    ('DD', 'tasks', 'title'), ('DD', 'tasks', 'client_name'), ('DD', 'tasks', 'deleted_at'),
    ('DD', 'clients', 'id'), ('DD', 'clients', 'name')
  ) e(phase, tbl, col)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) as typ from pg_attribute a
     where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = e.col and a.attnum > 0 and not a.attisdropped
  ) x on true
) checks
order by ok, check_name;
