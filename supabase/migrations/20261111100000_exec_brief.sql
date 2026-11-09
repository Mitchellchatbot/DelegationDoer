-- Executive AI Assistant — P8 morning brief.
--
--   exec_briefs          one row per (principal, local_date): the brief's content (sections of short lines with their
--                        refs, the top 3, novelty verdicts, counts; never a message body), the delivery status machine
--                        (CAS), the Slack refs of what was posted, and the watchdog's fallback stamps.
--   exec_brief_checkins  hash-bound check-ins written from DD data only: one row per suggested message, sent at most
--                        once by CAS, as Mitchell, from his own DD Slack token after an auth.test binding.
--   exec_brief_mentions  novelty: how each situation looked the last time a brief showed it.
--
-- Functions (SECURITY INVOKER, search_path pinned, EXECUTE for service_role only):
--   exec_brief_claim_build     insert-or-claim the day's row for a build (schedule, retry, regenerate).
--   exec_brief_finish_build    write the content by CAS on rev; mark mentions on the day's first successful build.
--   exec_brief_delivery_step   CAS on the delivery status; counts posts; a third post is impossible (CHECK).
--   exec_brief_claim_fallback  insert the day's row if missing, then stamp fallback_sent_at by CAS.
--   exec_brief_scrub_threads   tombstones: brief lines citing restricted threads become "[Removed: restricted sender]".
--   exec_brief_scrub_slack     Slack deletes, leaves, revokes: brief lines citing them are removed.
--   exec_brief_purge_expired   TTLs: content 30 days, rows 180 days, check-ins 30 days, mentions 90 days.
--   exec_brief_item_hit, exec_brief_scrub_content, exec_brief_ref_array   pure helpers of the two scrubs.
--   exec_slack_accept_action_v2  P6's interactions ack, copied verbatim + 'ea_ci_send' / 'ea_ci_rewrite', which enqueue
--                              one check-in job per click. P6's exec_slack_accept_action is NOT touched: re-running P6's
--                              file can't drop the check-in actions; DD's store calls v2 and falls back to v1.
--
-- Earlier phases' objects are NOT changed: no CHECK, function, column or index of P2a-P7b is redefined. In particular
-- P6's exec_slack_posts CHECKs stay exactly P6's (p8-bindings.md AM-P8-2): every DM the assistant bot posts for P8 (the
-- brief, the late note, the scrubbed note, the check-ins message, the network alert) is a ledger row of kind 'note',
-- and P6's daily DM purge deletes every bot message of his DM older than retention_days_chat whatever its ledger kind.
--
-- Security: RLS ON with NO policies; nothing granted to anon/authenticated.
-- Idempotent. Apply MANUALLY in the Supabase SQL editor AFTER 20261110100000_exec_slack_intel.sql
-- (structurally it needs only P2a, P3 and P6; the pre-flight checks those).
-- Nothing runs until EXEC_ENABLED=true and brief_enabled is turned on in Executive AI → Settings.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: refuse, with nothing changed, a database without P2a, P3, P6 or the DD tables P8 reads.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_jobs') is null
     or to_regclass('public.exec_settings') is null or to_regclass('public.exec_ai_usage') is null then
    raise exception 'exec brief aborted, nothing changed: the P2a foundation is missing (apply 20261104100000_exec_foundation.sql first)';
  end if;
  if to_regclass('public.exec_email_threads') is null then
    raise exception 'exec brief aborted, nothing changed: P3 email is missing (apply 20261105100000_exec_email.sql first)';
  end if;
  if to_regclass('public.exec_slack_installations') is null or to_regclass('public.exec_slack_posts') is null
     or to_regprocedure('public.exec_slack_accept_action(text, text, text, text, text, text, text, text, text)') is null then
    raise exception 'exec brief aborted, nothing changed: P6 Slack is missing (apply 20261108100000_exec_slack.sql first)';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'exec_slack_posts_kind_check') then
    raise exception 'exec brief aborted, nothing changed: exec_slack_posts_kind_check is missing (P6 migration incomplete)';
  end if;
  if to_regclass('public.daily_briefings') is null or to_regclass('public.users') is null then
    raise exception 'exec brief aborted, nothing changed: the DD tables daily_briefings and users must exist';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. exec_briefs (M2, M4, M9; C14, C28, C36, C47, C49)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_briefs (
  id                  text primary key default ('eb_' || replace(gen_random_uuid()::text, '-', ''))
                        constraint exec_briefs_id_check check (id ~ '^eb_[0-9a-f]{32}$'),
  principal_id        text not null references public.exec_principals(id) on delete cascade,
  -- The brief's local date in tz (the brief zone at build time, M3).
  local_date          date not null,
  tz                  text not null constraint exec_briefs_tz_check check (char_length(tz) between 1 and 64),
  -- brief_local_time on local_date in tz (DST-correct, time.ts localTimeToUtc).
  scheduled_at        timestamptz not null,
  rev                 integer not null default 1 constraint exec_briefs_rev_check check (rev between 1 and 10000),
  status              text not null constraint exec_briefs_status_check
                        check (status in ('building', 'built', 'delivering', 'delivered', 'delivery_unknown', 'page_only', 'failed')),
  status_reason       text constraint exec_briefs_status_reason_check check (status_reason is null or status_reason ~ '^[a-z_]{1,40}$'),
  -- The M1 verdict at build time.
  owner               text constraint exec_briefs_owner_check check (owner is null or owner in ('exec', 'legacy', 'exec_page_only')),
  owner_reason        text constraint exec_briefs_owner_reason_check check (owner_reason is null or owner_reason ~ '^[a-z_]{1,40}$'),
  mode                text constraint exec_briefs_mode_check check (mode is null or mode in ('ai', 'deterministic')),
  mode_reason         text constraint exec_briefs_mode_reason_check
                        check (mode_reason is null or mode_reason in ('refused', 'truncated', 'budget', 'invalid_output', 'model_error', 'timeout')),
  -- The brief (§2.3): short lines with their refs, the top 3, novelty verdicts, counts. Never a body or excerpt.
  content             jsonb constraint exec_briefs_content_check
                        check (content is null or (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 262144)),
  -- Denormalized from content for the scrubs (GIN): P3 thread ids; Slack keys m:<channel>:<ts> and d:<channel>:<YYYY-MM-DD>; channel ids.
  ref_thread_ids      text[] not null default '{}' constraint exec_briefs_ref_threads_check check (cardinality(ref_thread_ids) <= 400),
  ref_slack_keys      text[] not null default '{}' constraint exec_briefs_ref_slack_keys_check check (cardinality(ref_slack_keys) <= 400),
  ref_slack_channels  text[] not null default '{}' constraint exec_briefs_ref_slack_channels_check check (cardinality(ref_slack_channels) <= 200),
  build_started_at    timestamptz,             -- null on a row the watchdog inserted before any build (C36)
  built_at            timestamptz,             -- first successful build
  regen_lock_until    timestamptz,
  -- C47: bumped by every regenerate claim; part of the regenerate job's dedupe key.
  regen_seq           integer not null default 0 constraint exec_briefs_regen_seq_check check (regen_seq between 0 and 100000),
  novelty_marked_at   timestamptz,
  delivery_started_at timestamptz,
  post_attempts       smallint not null default 0 constraint exec_briefs_post_attempts_check check (post_attempts between 0 and 2),
  delivered_at        timestamptz,
  slack_channel_id    text constraint exec_briefs_channel_check check (slack_channel_id is null or slack_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  slack_ts            text constraint exec_briefs_ts_check check (slack_ts is null or slack_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  checkins_ts         text constraint exec_briefs_checkins_ts_check check (checkins_ts is null or checkins_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  late_note_ts        text constraint exec_briefs_late_ts_check check (late_note_ts is null or late_note_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  fallback_sent_at    timestamptz,             -- the watchdog's claim (set before its post)
  fallback_slack_ts   text constraint exec_briefs_fallback_ts_check check (fallback_slack_ts is null or fallback_slack_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  -- C49 (intel-18): the DD bot's IM with him, and when the system purge deletes the mini-brief there.
  fallback_channel_id text constraint exec_briefs_fallback_channel_check check (fallback_channel_id is null or fallback_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  fallback_delete_after timestamptz,
  fallback_deleted_at timestamptz,
  fallback_error_code text constraint exec_briefs_fallback_error_check check (fallback_error_code is null or fallback_error_code ~ '^[a-z0-9_]{1,60}$'),
  scrubbed_at         timestamptz,
  dm_followed_at      timestamptz,
  error_code          text constraint exec_briefs_error_code_check check (error_code is null or error_code ~ '^[a-z0-9_]{1,60}$'),
  content_expires_at  timestamptz not null,
  content_purged_at   timestamptz,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint exec_briefs_day_key unique (principal_id, local_date),
  constraint exec_briefs_delivered_check check ((status = 'delivered') = (delivered_at is not null)),
  constraint exec_briefs_delivered_refs_check check (delivered_at is null or (slack_ts is not null and slack_channel_id is not null)),
  constraint exec_briefs_delivering_check
    check (status not in ('delivering', 'delivery_unknown') or (delivery_started_at is not null and post_attempts >= 1)),
  constraint exec_briefs_content_presence_check
    check (content is not null or status in ('building', 'failed') or content_purged_at is not null),
  constraint exec_briefs_content_purged_check check (content_purged_at is null or content is null),
  constraint exec_briefs_mode_pair_check check ((mode is null) = (built_at is null)),
  constraint exec_briefs_fallback_pair_check
    check ((fallback_slack_ts is null and fallback_error_code is null) or fallback_sent_at is not null),
  constraint exec_briefs_fallback_dm_check
    check ((fallback_slack_ts is null) = (fallback_channel_id is null)
           and (fallback_slack_ts is null) = (fallback_delete_after is null)
           and (fallback_deleted_at is null or fallback_slack_ts is not null)),
  constraint exec_briefs_late_note_check check (late_note_ts is null or fallback_sent_at is not null),
  constraint exec_briefs_checkins_msg_check check (checkins_ts is null or delivered_at is not null or late_note_ts is not null),
  constraint exec_briefs_expiry_check check (expires_at >= content_expires_at)
);
create index if not exists exec_briefs_threads_gin on public.exec_briefs using gin (ref_thread_ids);
create index if not exists exec_briefs_slack_keys_gin on public.exec_briefs using gin (ref_slack_keys);
create index if not exists exec_briefs_slack_channels_gin on public.exec_briefs using gin (ref_slack_channels);
create index if not exists exec_briefs_content_expiry_idx on public.exec_briefs (content_expires_at) where content is not null;
create index if not exists exec_briefs_expiry_idx on public.exec_briefs (expires_at);
create index if not exists exec_briefs_open_idx on public.exec_briefs (principal_id, local_date)
  where status in ('building', 'built', 'delivering');
create index if not exists exec_briefs_followup_idx on public.exec_briefs (principal_id)
  where scrubbed_at is not null and delivered_at is not null;
create index if not exists exec_briefs_fallback_dm_idx on public.exec_briefs (fallback_delete_after)
  where fallback_slack_ts is not null and fallback_deleted_at is null;

-- exec_briefs_post_attempts_check is M2's "never a third post" in the database: exec_brief_delivery_step counts each
-- post before it is made, and a third count can't be stored.

-- ---------------------------------------------------------------------------
-- 2. exec_brief_checkins (M6; C6, C45, C50)
-- ---------------------------------------------------------------------------

create table if not exists public.exec_brief_checkins (
  id                 text primary key default ('ebc_' || replace(gen_random_uuid()::text, '-', ''))
                       constraint exec_brief_checkins_id_check check (id ~ '^ebc_[0-9a-f]{32}$'),
  brief_id           text not null references public.exec_briefs(id) on delete cascade,
  principal_id       text not null references public.exec_principals(id) on delete cascade,
  local_date         date not null,
  brief_rev          integer not null constraint exec_brief_checkins_brief_rev_check check (brief_rev between 1 and 10000),
  rev                integer not null default 1 constraint exec_brief_checkins_rev_check check (rev between 1 and 1000),
  -- Off-boarding hard-deletes users (supabase/migrations/20260731000000_offboard_user.sql); a cascade FK doesn't block it.
  recipient_user_id  text not null references public.users(id) on delete cascade,
  recipient_slack_id text not null constraint exec_brief_checkins_slack_user_check check (recipient_slack_id ~ '^[UW][A-Z0-9]{2,30}$'),
  -- The only text column outside exec_briefs.content: written from DD data only (M6), plain text, 1..600.
  text               text not null constraint exec_brief_checkins_text_check check (char_length(text) between 1 and 600),
  status             text not null default 'proposed' constraint exec_brief_checkins_status_check
                       check (status in ('proposed', 'sending', 'sent', 'unknown', 'failed', 'expired')),
  status_reason      text constraint exec_brief_checkins_reason_check check (status_reason is null or status_reason ~ '^[a-z0-9_]{1,60}$'),
  sending_at         timestamptz,
  sent_at            timestamptz,
  slack_channel_id   text constraint exec_brief_checkins_channel_check check (slack_channel_id is null or slack_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  -- P7a's exec_slack_note_from_him reads (principal_id, slack_ts) to keep check-ins from counting as his answers (P7aC C21).
  slack_ts           text constraint exec_brief_checkins_ts_check check (slack_ts is null or slack_ts ~ '^[0-9]{1,12}\.[0-9]{1,8}$'),
  audit_id           bigint,
  -- Buttons are valid until expires_at (48 h, or the next day's build expires the row first, C45).
  expires_at         timestamptz not null,
  purge_at           timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint exec_brief_checkins_sent_check check ((status = 'sent') = (sent_at is not null)),
  constraint exec_brief_checkins_sent_refs_check check (status <> 'sent' or (slack_ts is not null and slack_channel_id is not null)),
  constraint exec_brief_checkins_sending_check
    check (status not in ('sending', 'sent', 'unknown') or (sending_at is not null and audit_id is not null)),
  constraint exec_brief_checkins_window_check check (expires_at > created_at and purge_at >= expires_at)
);
create unique index if not exists exec_brief_checkins_live_key
  on public.exec_brief_checkins (brief_id, recipient_user_id) where status <> 'expired';
create index if not exists exec_brief_checkins_day_idx on public.exec_brief_checkins (principal_id, local_date, status);
create index if not exists exec_brief_checkins_slack_ts_idx on public.exec_brief_checkins (principal_id, slack_ts) where slack_ts is not null;
create index if not exists exec_brief_checkins_recipient_idx on public.exec_brief_checkins (recipient_user_id, created_at desc);
create index if not exists exec_brief_checkins_brief_idx on public.exec_brief_checkins (brief_id);
create index if not exists exec_brief_checkins_purge_idx on public.exec_brief_checkins (purge_at);

-- ---------------------------------------------------------------------------
-- 3. exec_brief_mentions (M8): fingerprints, a state hash, a band and a date; no text.
-- ---------------------------------------------------------------------------

create table if not exists public.exec_brief_mentions (
  principal_id      text not null references public.exec_principals(id) on delete cascade,
  fingerprint       text not null constraint exec_brief_mentions_fp_check check (char_length(fingerprint) between 1 and 300),
  last_state_hash   text not null constraint exec_brief_mentions_state_check check (char_length(last_state_hash) between 1 and 128),
  last_band         text not null constraint exec_brief_mentions_band_check check (last_band in ('critical', 'high', 'normal')),
  last_mentioned_on date not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint exec_brief_mentions_pkey primary key (principal_id, fingerprint)
);
create index if not exists exec_brief_mentions_ttl_idx on public.exec_brief_mentions (last_mentioned_on);

-- ---------------------------------------------------------------------------
-- 4. Helpers of the scrubs (pure SQL; also exercised directly by the SQL suite)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_brief_item_hit(jsonb, text[], text[], text[], boolean);
create or replace function public.exec_brief_item_hit(
  p_item jsonb, p_thread_ids text[], p_slack_keys text[], p_channels text[], p_all_slack boolean
) returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
       (jsonb_typeof(p_item -> 'threadIds') = 'array' and coalesce(cardinality(p_thread_ids), 0) > 0
          and (p_item -> 'threadIds') ?| p_thread_ids)
    or (jsonb_typeof(p_item -> 'slackKeys') = 'array' and coalesce(cardinality(p_slack_keys), 0) > 0
          and (p_item -> 'slackKeys') ?| p_slack_keys)
    or (jsonb_typeof(p_item -> 'slackChannels') = 'array' and coalesce(cardinality(p_channels), 0) > 0
          and (p_item -> 'slackChannels') ?| p_channels)
    or (coalesce(p_all_slack, false) and jsonb_typeof(p_item -> 'slackChannels') = 'array'
          and jsonb_array_length(p_item -> 'slackChannels') > 0),
    false);
$$;

drop function if exists public.exec_brief_scrub_content(jsonb, text[], text[], text[], boolean, text);
create or replace function public.exec_brief_scrub_content(
  p_content jsonb, p_thread_ids text[], p_slack_keys text[], p_channels text[], p_all_slack boolean, p_text text
) returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_sections jsonb := '[]'::jsonb;
  v_items    jsonb;
  v_pending  jsonb;
  v_top      jsonb := '[]'::jsonb;
  v_removed  text[] := '{}';
  v_dropped  boolean := false;   -- a pending line or a top-3 entry was dropped
  s          jsonb;
  it         jsonb;
begin
  if p_content is null then return null; end if;
  for s in select value from jsonb_array_elements(coalesce(p_content -> 'sections', '[]'::jsonb)) loop
    v_items := '[]'::jsonb;
    for it in select value from jsonb_array_elements(coalesce(s -> 'items', '[]'::jsonb)) loop
      if public.exec_brief_item_hit(it, p_thread_ids, p_slack_keys, p_channels, p_all_slack) then
        v_removed := v_removed || (it ->> 'id');
        it := jsonb_build_object(
          'id', it -> 'id', 'text', to_jsonb(p_text), 'kind', to_jsonb('fact'::text),
          'basis', coalesce(it -> 'basis', to_jsonb('record'::text)), 'band', coalesce(it -> 'band', to_jsonb('normal'::text)),
          'aliases', '[]'::jsonb, 'fps', '[]'::jsonb, 'refs', '[]'::jsonb,
          'threadIds', '[]'::jsonb, 'slackKeys', '[]'::jsonb, 'slackChannels', '[]'::jsonb, 'scrubbed', true);
      end if;
      v_items := v_items || jsonb_build_array(it);
    end loop;
    v_pending := '[]'::jsonb;
    for it in select value from jsonb_array_elements(coalesce(s -> 'pending', '[]'::jsonb)) loop
      if not public.exec_brief_item_hit(it, p_thread_ids, p_slack_keys, p_channels, p_all_slack) then
        v_pending := v_pending || jsonb_build_array(it);
      else
        v_dropped := true;
      end if;
    end loop;
    v_sections := v_sections || jsonb_build_array(s || jsonb_build_object('items', v_items, 'pending', v_pending));
  end loop;
  for it in select value from jsonb_array_elements(coalesce(p_content -> 'top3', '[]'::jsonb)) loop
    if not public.exec_brief_item_hit(it, p_thread_ids, p_slack_keys, p_channels, p_all_slack)
       and not coalesce((it ->> 'itemId') = any (v_removed), false) then
      v_top := v_top || jsonb_build_array(it);
    else
      v_dropped := true;
    end if;
  end loop;
  -- intel-14: the headline is one AI sentence over the whole day with no refs, so it can't be scrubbed line by line.
  -- Whenever this scrub changed anything (or the whole Slack half is gone), the headline goes too.
  if cardinality(v_removed) > 0 or v_dropped or coalesce(p_all_slack, false) then
    return p_content || jsonb_build_object('sections', v_sections, 'top3', v_top, 'scrubbed', true,
                                           'headline', null, 'headlineScrubbed', true);
  end if;
  return p_content || jsonb_build_object('sections', v_sections, 'top3', v_top, 'scrubbed', true);
end;
$$;

drop function if exists public.exec_brief_ref_array(jsonb, text);
create or replace function public.exec_brief_ref_array(p_content jsonb, p_key text) returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(distinct x.v order by x.v), '{}'::text[])
    from (
      select jsonb_array_elements_text(e.value -> p_key) as v
        from (
          select i.value
            from jsonb_array_elements(coalesce(p_content -> 'sections', '[]'::jsonb)) s,
                 jsonb_array_elements(coalesce(s.value -> 'items', '[]'::jsonb)) i
          union all
          select pd.value
            from jsonb_array_elements(coalesce(p_content -> 'sections', '[]'::jsonb)) s,
                 jsonb_array_elements(coalesce(s.value -> 'pending', '[]'::jsonb)) pd
          union all
          select t.value from jsonb_array_elements(coalesce(p_content -> 'top3', '[]'::jsonb)) t
        ) e
       where jsonb_typeof(e.value -> p_key) = 'array'
    ) x;
$$;

-- ---------------------------------------------------------------------------
-- 5. RPC 1: exec_brief_claim_build (M2, M3; C5, C36, C47, C48)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_brief_claim_build(text, date, text, timestamptz, text, integer, timestamptz, timestamptz, integer);
create or replace function public.exec_brief_claim_build(
  p_principal          text,
  p_local_date         date,
  p_tz                 text,
  p_scheduled_at       timestamptz,
  p_trigger            text,          -- 'schedule' | 'retry' | 'regenerate'
  p_expected_rev       integer,       -- regenerate: the rev the caller showed; null otherwise
  p_content_expires_at timestamptz,
  p_expires_at         timestamptz,
  p_regen_lock_seconds integer        -- regenerate: the lock (60..900, default 300)
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v public.exec_briefs%rowtype;
begin
  if p_principal is null or p_local_date is null then raise exception 'exec_brief_claim_build: principal and date are required'; end if;
  if p_trigger is null or p_trigger not in ('schedule', 'retry', 'regenerate') then
    raise exception 'exec_brief_claim_build: bad trigger %', p_trigger;
  end if;
  if p_trigger <> 'regenerate' then
    insert into public.exec_briefs (principal_id, local_date, tz, scheduled_at, status, build_started_at, content_expires_at, expires_at)
    values (p_principal, p_local_date, p_tz, p_scheduled_at, 'building', now(), p_content_expires_at, p_expires_at)
    on conflict (principal_id, local_date) do nothing
    returning * into v;
    if found then
      return jsonb_build_object('outcome', 'claimed', 'id', v.id, 'rev', v.rev, 'first', true, 'fallback_sent', false);
    end if;
    select * into v from public.exec_briefs where principal_id = p_principal and local_date = p_local_date for update;
    -- A row the watchdog inserted before any build (C36).
    if v.status = 'building' and v.build_started_at is null then
      update public.exec_briefs set build_started_at = now(), tz = p_tz, scheduled_at = p_scheduled_at, updated_at = now()
       where id = v.id returning * into v;
      return jsonb_build_object('outcome', 'claimed', 'id', v.id, 'rev', v.rev, 'first', true,
                                'fallback_sent', v.fallback_sent_at is not null);
    end if;
    -- A pre-model failure being retried (C5). Nothing else may be re-claimed by a non-regenerate trigger.
    if p_trigger = 'retry' and v.status = 'failed' and v.status_reason = 'pre_model' and v.built_at is null then
      update public.exec_briefs
         set status = 'building', status_reason = null, error_code = null, build_started_at = now(), updated_at = now()
       where id = v.id returning * into v;
      return jsonb_build_object('outcome', 'claimed', 'id', v.id, 'rev', v.rev, 'first', true,
                                'fallback_sent', v.fallback_sent_at is not null);
    end if;
    return jsonb_build_object('outcome', 'exists', 'id', v.id, 'rev', v.rev, 'status', v.status);
  end if;
  select * into v from public.exec_briefs where principal_id = p_principal and local_date = p_local_date for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if p_expected_rev is null or v.rev <> p_expected_rev then return jsonb_build_object('outcome', 'conflict', 'rev', v.rev); end if;
  -- intel-11 (C48): a 'built' row whose full delivery can no longer run (the watchdog claimed, or nothing moved it for
  -- 10 minutes since it was built) may be regenerated; a fresh 'built' row is still about to be delivered. A row is
  -- 'built' only after a schedule/retry finish, so built_at is the moment it became 'built' (stable, unlike updated_at).
  if v.status in ('building', 'delivering')
     or (v.status = 'built' and v.fallback_sent_at is null and v.built_at > now() - interval '10 minutes')
     or (v.regen_lock_until is not null and v.regen_lock_until > now()) then
    return jsonb_build_object('outcome', 'busy', 'rev', v.rev, 'status', v.status);
  end if;
  -- intel-12 (C47): every claim gets its own sequence number, part of the job's dedupe key.
  update public.exec_briefs
     set regen_lock_until = now() + make_interval(secs => least(greatest(coalesce(p_regen_lock_seconds, 300), 60), 900)),
         regen_seq = regen_seq + 1,
         updated_at = now()
   where id = v.id
  returning * into v;
  return jsonb_build_object('outcome', 'claimed', 'id', v.id, 'rev', v.rev, 'first', v.built_at is null,
                            'fallback_sent', v.fallback_sent_at is not null, 'status', v.status, 'regen_seq', v.regen_seq);
end;
$$;

-- A build's own failure is a plain PostgREST CAS in brief-store.ts (failBuild): status 'failed' with status_reason
-- 'pre_model' | 'post_model' where id, status = 'building' and rev; a regenerate's failure (and a regenerate whose job
-- couldn't be enqueued) clears its lock by a plain CAS on (id, rev). regen_seq never resets; a schedule or retry claim
-- doesn't touch it.

-- ---------------------------------------------------------------------------
-- 6. RPC 2: exec_brief_finish_build (the content write and M8's marking, one transaction)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_brief_finish_build(text, integer, text, text, text, text, text, text, text, jsonb,
  text[], text[], text[], jsonb, date);
create or replace function public.exec_brief_finish_build(
  p_id             text,
  p_expected_rev   integer,
  p_trigger        text,      -- 'schedule' | 'retry' | 'regenerate'
  p_status         text,      -- 'built' | 'page_only' (a regenerate keeps the delivery status, M3; 'failed'/'built' → 'page_only')
  p_status_reason  text,
  p_owner          text,
  p_owner_reason   text,
  p_mode           text,
  p_mode_reason    text,
  p_content        jsonb,
  p_thread_ids     text[],
  p_slack_keys     text[],
  p_slack_channels text[],
  p_mentions       jsonb,     -- [{ "fp", "state", "band" }], distinct fps, ≤ 400, sent by EVERY build: marked only while
                              -- novelty_marked_at is null, i.e. by the day's first successful build whatever its trigger (intel-16)
  p_mentioned_on   date
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v          public.exec_briefs%rowtype;
  v_rev      integer;
  v_status   text;
  v_reason   text;
  v_marked   integer := 0;
  v_threads  text[] := coalesce(p_thread_ids, '{}'::text[]);
  v_keys     text[] := coalesce(p_slack_keys, '{}'::text[]);
  v_channels text[] := coalesce(p_slack_channels, '{}'::text[]);
  v_follow   boolean := false;
begin
  if p_status is null or p_status not in ('built', 'page_only') then raise exception 'exec_brief_finish_build: bad status %', p_status; end if;
  if p_trigger is null or p_trigger not in ('schedule', 'retry', 'regenerate') then raise exception 'exec_brief_finish_build: bad trigger'; end if;
  if p_expected_rev is null then raise exception 'exec_brief_finish_build: the expected rev is required'; end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then raise exception 'exec_brief_finish_build: content must be an object'; end if;
  if p_mentions is null or jsonb_typeof(p_mentions) <> 'array' or jsonb_array_length(p_mentions) > 400 then
    raise exception 'exec_brief_finish_build: mentions must be an array of at most 400';
  end if;
  select * into v from public.exec_briefs where id = p_id for update;
  if not found then return jsonb_build_object('outcome', 'lost'); end if;
  if v.rev <> p_expected_rev then return jsonb_build_object('outcome', 'conflict', 'rev', v.rev, 'status', v.status); end if;
  if p_trigger = 'regenerate' then
    -- P8 fixer correctness-1: the claim's busy rule again, at the finish. A pre-model retry may have claimed the row (failed ->
    -- building) or finished it (a fresh 'built') while this regenerate ran (its lock can lapse while the job waits or runs), or
    -- a same-day delivery may be posting it: the scheduled build wins and this regenerate yields (its job releases its lock).
    if v.status in ('building', 'delivering')
       or (v.status = 'built' and v.fallback_sent_at is null and v.built_at > now() - interval '10 minutes') then
      return jsonb_build_object('outcome', 'conflict', 'rev', v.rev, 'status', v.status);
    end if;
    -- P8 fixer security-1: the DM may still hold an earlier version's lines. Their refs are kept (the sorted distinct union with
    -- the new content's), so a later scrub of one of them still finds this row and sets scrubbed_at (C15 then replaces the DM).
    -- A union past a cardinality CHECK can't be tracked: the DM is followed up now instead (scrubbed_at), on the new refs.
    if v.delivered_at is not null or v.status = 'delivery_unknown' then
      select coalesce(array_agg(distinct x order by x), '{}'::text[]) into v_threads from unnest(v.ref_thread_ids || v_threads) x;
      select coalesce(array_agg(distinct x order by x), '{}'::text[]) into v_keys from unnest(v.ref_slack_keys || v_keys) x;
      select coalesce(array_agg(distinct x order by x), '{}'::text[]) into v_channels from unnest(v.ref_slack_channels || v_channels) x;
      if cardinality(v_threads) > 400 or cardinality(v_keys) > 400 or cardinality(v_channels) > 200 then
        v_threads := coalesce(p_thread_ids, '{}'::text[]);
        v_keys := coalesce(p_slack_keys, '{}'::text[]);
        v_channels := coalesce(p_slack_channels, '{}'::text[]);
        v_follow := true;
      end if;
    end if;
    v_rev := v.rev + 1;
    -- A regenerate is page-only (M3). 'built' reaches here only when its full delivery can no longer run (C48): it ends
    -- page_only too, so a late full-delivery job can never post the regenerated content.
    v_status := case when v.status in ('failed', 'built') then 'page_only' else v.status end;
    v_reason := case when v.status = 'failed' then 'regenerated'
                     when v.status = 'built' then case when v.fallback_sent_at is not null then 'after_fallback' else 'delivery_failed' end
                     else v.status_reason end;
  else
    if v.status <> 'building' then return jsonb_build_object('outcome', 'conflict', 'rev', v.rev, 'status', v.status); end if;
    v_rev := v.rev;
    v_status := p_status;
    v_reason := p_status_reason;
  end if;
  update public.exec_briefs
     set rev = v_rev, status = v_status, status_reason = v_reason,
         owner = p_owner, owner_reason = p_owner_reason, mode = p_mode, mode_reason = p_mode_reason,
         content = p_content, content_purged_at = null,
         ref_thread_ids = v_threads, ref_slack_keys = v_keys, ref_slack_channels = v_channels,
         scrubbed_at = case when v_follow then now() else scrubbed_at end,
         built_at = coalesce(built_at, now()), regen_lock_until = null, error_code = null,
         novelty_marked_at = coalesce(novelty_marked_at, now()), updated_at = now()
   where id = p_id;
  if v.novelty_marked_at is null then
    insert into public.exec_brief_mentions (principal_id, fingerprint, last_state_hash, last_band, last_mentioned_on)
    select v.principal_id, m ->> 'fp', m ->> 'state', m ->> 'band', p_mentioned_on
      from jsonb_array_elements(p_mentions) m
    on conflict (principal_id, fingerprint) do update
       set last_state_hash = excluded.last_state_hash, last_band = excluded.last_band,
           last_mentioned_on = greatest(public.exec_brief_mentions.last_mentioned_on, excluded.last_mentioned_on),
           updated_at = now();
    get diagnostics v_marked = row_count;
  end if;
  return jsonb_build_object('outcome', 'ok', 'id', p_id, 'rev', v_rev, 'status', v_status, 'marked', v_marked);
end;
$$;

-- The TS caller de-duplicates p_mentions by fingerprint (an on conflict do update can't touch a row twice in one
-- statement) and validates every element against the table CHECKs before the call. It always sends them, for every
-- trigger (intel-16): the novelty_marked_at guard above is the only "first build" test.

-- ---------------------------------------------------------------------------
-- 7. RPC 3: exec_brief_delivery_step (M2)
-- ---------------------------------------------------------------------------
-- Allowed transitions (anything else returns false or raises): built → delivering (+1),
-- page_only[not_superseding|no_installation] → delivering (+1), delivering → delivering (+1, only while
-- post_attempts < 2), delivering → delivered, delivering → delivery_unknown, delivering → page_only (a clear
-- failure, C35), built → page_only.

drop function if exists public.exec_brief_delivery_step(text, text[], text, boolean, text, text, text, text);
create or replace function public.exec_brief_delivery_step(
  p_id         text,
  p_from       text[],    -- ⊆ {built, page_only, delivering}
  p_to         text,      -- delivering | delivered | delivery_unknown | page_only
  p_count_post boolean,   -- true exactly when entering delivering, right before a chat.postMessage
  p_channel    text,      -- delivered only
  p_ts         text,      -- delivered only
  p_reason     text,      -- page_only / delivery_unknown: the status reason
  p_error_code text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  if p_to is null or p_to not in ('delivering', 'delivered', 'delivery_unknown', 'page_only') then
    raise exception 'exec_brief_delivery_step: bad target %', p_to;
  end if;
  if p_from is null or cardinality(p_from) = 0 or not (p_from <@ array['built', 'page_only', 'delivering']::text[]) then
    raise exception 'exec_brief_delivery_step: bad source';
  end if;
  if (p_to = 'delivering') <> coalesce(p_count_post, false) then
    raise exception 'exec_brief_delivery_step: a post is counted exactly on the way into delivering';
  end if;
  if p_to = 'delivered' and (p_ts is null or p_channel is null) then
    raise exception 'exec_brief_delivery_step: delivered needs the channel and ts';
  end if;
  update public.exec_briefs
     set status = p_to,
         post_attempts = post_attempts + case when p_count_post then 1 else 0 end,
         delivery_started_at = case when p_to = 'delivering' then coalesce(delivery_started_at, now()) else delivery_started_at end,
         delivered_at = case when p_to = 'delivered' then now() else delivered_at end,
         slack_channel_id = case when p_to = 'delivered' then p_channel else slack_channel_id end,
         slack_ts = case when p_to = 'delivered' then p_ts else slack_ts end,
         status_reason = case when p_to in ('page_only', 'delivery_unknown') then p_reason else null end,
         error_code = coalesce(p_error_code, error_code),
         updated_at = now()
   where id = p_id
     and status = any (p_from)
     and delivered_at is null
     and (not coalesce(p_count_post, false) or post_attempts < 2)
     and (p_to not in ('delivered', 'delivery_unknown') or status = 'delivering')
     -- M3: after the watchdog, the full brief is never DMed; a page-only row is re-delivered only for these reasons (M2).
     and (p_to <> 'delivering' or fallback_sent_at is null)
     and (p_to <> 'delivering' or status <> 'page_only' or status_reason in ('not_superseding', 'no_installation'));
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- The fallback result, the check-ins message refs and the follow-ups are plain PostgREST CAS in brief-store.ts
-- (recordFallbackResult, listFallbackDmsDue, markFallbackDmDeleted, listStaleBuilt, recordCheckinsMessage,
-- recordLateNote, markDmFollowed, failStaleBuilds).

-- ---------------------------------------------------------------------------
-- 8. RPC 4: exec_brief_claim_fallback (M7; C32, C36)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_brief_claim_fallback(text, date, text, timestamptz, timestamptz, timestamptz);
create or replace function public.exec_brief_claim_fallback(
  p_principal text, p_local_date date, p_tz text, p_scheduled_at timestamptz,
  p_content_expires_at timestamptz, p_expires_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v public.exec_briefs%rowtype;
begin
  if p_principal is null or p_local_date is null then raise exception 'exec_brief_claim_fallback: principal and date are required'; end if;
  insert into public.exec_briefs (principal_id, local_date, tz, scheduled_at, status, content_expires_at, expires_at)
  values (p_principal, p_local_date, p_tz, p_scheduled_at, 'building', p_content_expires_at, p_expires_at)
  on conflict (principal_id, local_date) do nothing;
  select * into v from public.exec_briefs where principal_id = p_principal and local_date = p_local_date for update;
  if v.delivered_at is not null then return jsonb_build_object('outcome', 'delivered', 'id', v.id); end if;
  if v.status in ('delivering', 'delivery_unknown') then
    return jsonb_build_object('outcome', 'in_flight', 'id', v.id, 'status', v.status);
  end if;
  if v.fallback_sent_at is not null then return jsonb_build_object('outcome', 'already', 'id', v.id); end if;
  update public.exec_briefs set fallback_sent_at = now(), updated_at = now() where id = v.id;
  return jsonb_build_object('outcome', 'claimed', 'id', v.id, 'status', v.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. RPC 5 and 6: the scrubs (M9, C16; intel-14)
-- ---------------------------------------------------------------------------

drop function if exists public.exec_brief_scrub_threads(text, text[]);
create or replace function public.exec_brief_scrub_threads(p_principal text, p_thread_ids text[]) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  if p_principal is null then raise exception 'exec_brief_scrub_threads: p_principal is required'; end if;
  if p_thread_ids is null or cardinality(p_thread_ids) = 0 then return 0; end if;
  if cardinality(p_thread_ids) > 500 then raise exception 'exec_brief_scrub_threads: at most 500 thread ids per call'; end if;
  with hit as (
    select b.id,
           public.exec_brief_scrub_content(b.content, p_thread_ids, '{}'::text[], '{}'::text[], false,
                                           '[Removed: restricted sender]') as c
      from public.exec_briefs b
     where b.principal_id = p_principal and b.content is not null and b.ref_thread_ids && p_thread_ids
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

drop function if exists public.exec_brief_scrub_slack(text, text[], text[], boolean);
create or replace function public.exec_brief_scrub_slack(
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
  if p_principal is null then raise exception 'exec_brief_scrub_slack: p_principal is required'; end if;
  if cardinality(v_keys) > 500 or cardinality(v_channels) > 500 then
    raise exception 'exec_brief_scrub_slack: at most 500 keys and 500 channels per call';
  end if;
  if not coalesce(p_all, false) and cardinality(v_keys) = 0 and cardinality(v_channels) = 0 then return 0; end if;
  with hit as (
    select b.id,
           public.exec_brief_scrub_content(b.content, '{}'::text[], v_keys, v_channels, coalesce(p_all, false),
                                           '[Removed: no longer available in Slack]') as c
      from public.exec_briefs b
     where b.principal_id = p_principal and b.content is not null
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
-- 10. RPC 7: exec_brief_purge_expired (M9, C28; called by the system purge)
-- ---------------------------------------------------------------------------
-- brief-store.ts's purgeExpiredBriefs(now) calls it up to 10 times while any count equals the limit, with
-- p_mention_cutoff = UTC date(now) - 90 days. All dates come from the app (C28), never now() in SQL.

drop function if exists public.exec_brief_purge_expired(timestamptz, integer, date);
create or replace function public.exec_brief_purge_expired(p_now timestamptz, p_limit integer, p_mention_cutoff date) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lim      integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_content  integer := 0;
  v_rows     integer := 0;
  v_checkins integer := 0;
  v_mentions integer := 0;
begin
  if p_now is null or p_mention_cutoff is null then raise exception 'exec_brief_purge_expired: now and the mention cutoff are required'; end if;
  with c as (
    select id from public.exec_briefs where content is not null and content_expires_at < p_now
     order by content_expires_at limit v_lim for update skip locked
  )
  update public.exec_briefs b
     set content = null, content_purged_at = p_now, ref_thread_ids = '{}', ref_slack_keys = '{}', ref_slack_channels = '{}',
         updated_at = now()
    from c where b.id = c.id;
  get diagnostics v_content = row_count;
  -- P8 fixer security-2: a row whose DD-bot mini-brief is still in Slack (posted, not yet deleted) keeps its channel and ts for
  -- up to 7 more days, so the system purge's ddBotFallbackDms step can still delete it (a 'retry' on the last day isn't lost).
  with d as (
    select id from public.exec_briefs
     where expires_at < p_now
       and (fallback_slack_ts is null or fallback_deleted_at is not null or expires_at < p_now - interval '7 days')
     order by expires_at limit v_lim for update skip locked
  )
  delete from public.exec_briefs b using d where b.id = d.id;
  get diagnostics v_rows = row_count;
  with d as (select id from public.exec_brief_checkins where purge_at < p_now order by purge_at limit v_lim for update skip locked)
  delete from public.exec_brief_checkins k using d where k.id = d.id;
  get diagnostics v_checkins = row_count;
  with d as (
    select principal_id, fingerprint from public.exec_brief_mentions where last_mentioned_on < p_mention_cutoff
     limit v_lim for update skip locked
  )
  delete from public.exec_brief_mentions m using d where m.principal_id = d.principal_id and m.fingerprint = d.fingerprint;
  get diagnostics v_mentions = row_count;
  return jsonb_build_object('contentPurged', v_content, 'briefsDeleted', v_rows, 'checkinsDeleted', v_checkins,
                            'mentionsDeleted', v_mentions);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. exec_slack_accept_action_v2: P6's RPC 2, versioned (C43; coherence-6, intel-17)
-- ---------------------------------------------------------------------------
-- P6's exec_slack_accept_action is NOT touched (P6's file drops and re-creates it, so an in-place replacement would be
-- silently reverted by a hand re-run of P6's idempotent migration, and check-in clicks would then answer
-- unknown_action). This is P6's final body copied verbatim with exactly two changes: the action allow-list gains
-- 'ea_ci_send' and 'ea_ci_rewrite', and the check-in branch below runs after P6's trigger check and before P6's insert.
-- The trigger id is used for the dedupe key only and is never stored anywhere else.

drop function if exists public.exec_slack_accept_action_v2(text, text, text, text, text, text, text, text, text);
create or replace function public.exec_slack_accept_action_v2(
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
                                                'ea_ci_send', 'ea_ci_rewrite') then
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
-- 12. Lockdown
-- ---------------------------------------------------------------------------

alter table public.exec_briefs         enable row level security;
alter table public.exec_brief_checkins enable row level security;
alter table public.exec_brief_mentions enable row level security;
revoke all on public.exec_briefs, public.exec_brief_checkins, public.exec_brief_mentions from public, anon, authenticated;
grant all on public.exec_briefs, public.exec_brief_checkins, public.exec_brief_mentions to service_role;

revoke all on function public.exec_brief_item_hit(jsonb, text[], text[], text[], boolean) from public, anon, authenticated;
revoke all on function public.exec_brief_scrub_content(jsonb, text[], text[], text[], boolean, text) from public, anon, authenticated;
revoke all on function public.exec_brief_ref_array(jsonb, text) from public, anon, authenticated;
revoke all on function public.exec_brief_claim_build(text, date, text, timestamptz, text, integer, timestamptz, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.exec_brief_finish_build(text, integer, text, text, text, text, text, text, text, jsonb,
  text[], text[], text[], jsonb, date) from public, anon, authenticated;
revoke all on function public.exec_brief_delivery_step(text, text[], text, boolean, text, text, text, text) from public, anon, authenticated;
revoke all on function public.exec_brief_claim_fallback(text, date, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_brief_scrub_threads(text, text[]) from public, anon, authenticated;
revoke all on function public.exec_brief_scrub_slack(text, text[], text[], boolean) from public, anon, authenticated;
revoke all on function public.exec_brief_purge_expired(timestamptz, integer, date) from public, anon, authenticated;
revoke all on function public.exec_slack_accept_action_v2(text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.exec_brief_item_hit(jsonb, text[], text[], text[], boolean) to service_role;
grant execute on function public.exec_brief_scrub_content(jsonb, text[], text[], text[], boolean, text) to service_role;
grant execute on function public.exec_brief_ref_array(jsonb, text) to service_role;
grant execute on function public.exec_brief_claim_build(text, date, text, timestamptz, text, integer, timestamptz, timestamptz, integer)
  to service_role;
grant execute on function public.exec_brief_finish_build(text, integer, text, text, text, text, text, text, text, jsonb,
  text[], text[], text[], jsonb, date) to service_role;
grant execute on function public.exec_brief_delivery_step(text, text[], text, boolean, text, text, text, text) to service_role;
grant execute on function public.exec_brief_claim_fallback(text, date, text, timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.exec_brief_scrub_threads(text, text[]) to service_role;
grant execute on function public.exec_brief_scrub_slack(text, text[], text[], boolean) to service_role;
grant execute on function public.exec_brief_purge_expired(timestamptz, integer, date) to service_role;
grant execute on function public.exec_slack_accept_action_v2(text, text, text, text, text, text, text, text, text) to service_role;

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
--   * every column of the three new tables with type and nullability, and the
--     defaults the app relies on;
--   * every named CHECK, validated (by the words their definition must hold);
--   * the primary keys, the unique day key, and the foreign keys with their
--     ON DELETE actions;
--   * every index by its definition (the text after " USING ") and uniqueness;
--   * the eleven functions: SECURITY INVOKER with search_path pinned, one
--     signature each; the three scrub helpers IMMUTABLE; the content scrub
--     nulls the headline (intel-14);
--   * exec_slack_accept_action_v2's body holds the check-in branch (one job per
--     click) AND P6's own path; P6's exec_slack_accept_action is still there and
--     still P6's (no check-in action in it);
--   * P6's ledger CHECKs untouched (AM-P8-2);
--   * what this file relies on from P3, P6 and DD, so a later re-apply of an
--     earlier phase that loses one turns a row false.
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
  select 'columns: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_briefs'), ('exec_brief_checkins'), ('exec_brief_mentions')) e(tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_briefs', 1, 'id', 'text', true),
      ('exec_briefs', 2, 'principal_id', 'text', true),
      ('exec_briefs', 3, 'local_date', 'date', true),
      ('exec_briefs', 4, 'tz', 'text', true),
      ('exec_briefs', 5, 'scheduled_at', 'timestamp with time zone', true),
      ('exec_briefs', 6, 'rev', 'integer', true),
      ('exec_briefs', 7, 'status', 'text', true),
      ('exec_briefs', 8, 'status_reason', 'text', false),
      ('exec_briefs', 9, 'owner', 'text', false),
      ('exec_briefs', 10, 'owner_reason', 'text', false),
      ('exec_briefs', 11, 'mode', 'text', false),
      ('exec_briefs', 12, 'mode_reason', 'text', false),
      ('exec_briefs', 13, 'content', 'jsonb', false),
      ('exec_briefs', 14, 'ref_thread_ids', 'text[]', true),
      ('exec_briefs', 15, 'ref_slack_keys', 'text[]', true),
      ('exec_briefs', 16, 'ref_slack_channels', 'text[]', true),
      ('exec_briefs', 17, 'build_started_at', 'timestamp with time zone', false),
      ('exec_briefs', 18, 'built_at', 'timestamp with time zone', false),
      ('exec_briefs', 19, 'regen_lock_until', 'timestamp with time zone', false),
      ('exec_briefs', 20, 'regen_seq', 'integer', true),
      ('exec_briefs', 21, 'novelty_marked_at', 'timestamp with time zone', false),
      ('exec_briefs', 22, 'delivery_started_at', 'timestamp with time zone', false),
      ('exec_briefs', 23, 'post_attempts', 'smallint', true),
      ('exec_briefs', 24, 'delivered_at', 'timestamp with time zone', false),
      ('exec_briefs', 25, 'slack_channel_id', 'text', false),
      ('exec_briefs', 26, 'slack_ts', 'text', false),
      ('exec_briefs', 27, 'checkins_ts', 'text', false),
      ('exec_briefs', 28, 'late_note_ts', 'text', false),
      ('exec_briefs', 29, 'fallback_sent_at', 'timestamp with time zone', false),
      ('exec_briefs', 30, 'fallback_slack_ts', 'text', false),
      ('exec_briefs', 31, 'fallback_channel_id', 'text', false),
      ('exec_briefs', 32, 'fallback_delete_after', 'timestamp with time zone', false),
      ('exec_briefs', 33, 'fallback_deleted_at', 'timestamp with time zone', false),
      ('exec_briefs', 34, 'fallback_error_code', 'text', false),
      ('exec_briefs', 35, 'scrubbed_at', 'timestamp with time zone', false),
      ('exec_briefs', 36, 'dm_followed_at', 'timestamp with time zone', false),
      ('exec_briefs', 37, 'error_code', 'text', false),
      ('exec_briefs', 38, 'content_expires_at', 'timestamp with time zone', true),
      ('exec_briefs', 39, 'content_purged_at', 'timestamp with time zone', false),
      ('exec_briefs', 40, 'expires_at', 'timestamp with time zone', true),
      ('exec_briefs', 41, 'created_at', 'timestamp with time zone', true),
      ('exec_briefs', 42, 'updated_at', 'timestamp with time zone', true),
      ('exec_brief_checkins', 1, 'id', 'text', true),
      ('exec_brief_checkins', 2, 'brief_id', 'text', true),
      ('exec_brief_checkins', 3, 'principal_id', 'text', true),
      ('exec_brief_checkins', 4, 'local_date', 'date', true),
      ('exec_brief_checkins', 5, 'brief_rev', 'integer', true),
      ('exec_brief_checkins', 6, 'rev', 'integer', true),
      ('exec_brief_checkins', 7, 'recipient_user_id', 'text', true),
      ('exec_brief_checkins', 8, 'recipient_slack_id', 'text', true),
      ('exec_brief_checkins', 9, 'text', 'text', true),
      ('exec_brief_checkins', 10, 'status', 'text', true),
      ('exec_brief_checkins', 11, 'status_reason', 'text', false),
      ('exec_brief_checkins', 12, 'sending_at', 'timestamp with time zone', false),
      ('exec_brief_checkins', 13, 'sent_at', 'timestamp with time zone', false),
      ('exec_brief_checkins', 14, 'slack_channel_id', 'text', false),
      ('exec_brief_checkins', 15, 'slack_ts', 'text', false),
      ('exec_brief_checkins', 16, 'audit_id', 'bigint', false),
      ('exec_brief_checkins', 17, 'expires_at', 'timestamp with time zone', true),
      ('exec_brief_checkins', 18, 'purge_at', 'timestamp with time zone', true),
      ('exec_brief_checkins', 19, 'created_at', 'timestamp with time zone', true),
      ('exec_brief_checkins', 20, 'updated_at', 'timestamp with time zone', true),
      ('exec_brief_mentions', 1, 'principal_id', 'text', true),
      ('exec_brief_mentions', 2, 'fingerprint', 'text', true),
      ('exec_brief_mentions', 3, 'last_state_hash', 'text', true),
      ('exec_brief_mentions', 4, 'last_band', 'text', true),
      ('exec_brief_mentions', 5, 'last_mentioned_on', 'date', true),
      ('exec_brief_mentions', 6, 'created_at', 'timestamp with time zone', true),
      ('exec_brief_mentions', 7, 'updated_at', 'timestamp with time zone', true)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select 'defaults: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_briefs'), ('exec_brief_checkins'), ('exec_brief_mentions')) e(tbl)
  cross join lateral (
    select string_agg(k.col || ' default ' || k.def, ', ' order by k.col) as wrong
    from (values
      ('exec_briefs', 'id', '(''eb_''::text || replace((gen_random_uuid())::text, ''-''::text, ''''::text))'),
      ('exec_briefs', 'rev', '1'),
      ('exec_briefs', 'ref_thread_ids', '''{}''::text[]'),
      ('exec_briefs', 'ref_slack_keys', '''{}''::text[]'),
      ('exec_briefs', 'ref_slack_channels', '''{}''::text[]'),
      ('exec_briefs', 'regen_seq', '0'),
      ('exec_briefs', 'post_attempts', '0'),
      ('exec_briefs', 'created_at', 'now()'),
      ('exec_briefs', 'updated_at', 'now()'),
      ('exec_brief_checkins', 'id', '(''ebc_''::text || replace((gen_random_uuid())::text, ''-''::text, ''''::text))'),
      ('exec_brief_checkins', 'rev', '1'),
      ('exec_brief_checkins', 'status', '''proposed''::text'),
      ('exec_brief_checkins', 'created_at', 'now()'),
      ('exec_brief_checkins', 'updated_at', 'now()'),
      ('exec_brief_mentions', 'created_at', 'now()'),
      ('exec_brief_mentions', 'updated_at', 'now()')
    ) k(tbl, col, def)
    where k.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = k.col and not a.attisdropped
          and pg_get_expr(d.adbin, d.adrelid) = k.def)
  ) x
  union all
  select 'checks: ' || e.tbl, x.missing is null, x.missing
  from (values ('exec_briefs'), ('exec_brief_checkins'), ('exec_brief_mentions')) e(tbl)
  cross join lateral (
    select string_agg(k.name || case when d.def is null then '' when not d.valid then ' (not validated)' else ' (definition)' end,
                      ', ' order by k.name) as missing
    from (values
      ('exec_briefs', 'exec_briefs_id_check', array['id', 'eb_']),
      ('exec_briefs', 'exec_briefs_tz_check', array['tz', '64']),
      ('exec_briefs', 'exec_briefs_rev_check', array['rev', '10000']),
      ('exec_briefs', 'exec_briefs_status_check',
       array['building', 'built', 'delivering', 'delivered', 'delivery_unknown', 'page_only', 'failed']),
      ('exec_briefs', 'exec_briefs_status_reason_check', array['status_reason']),
      ('exec_briefs', 'exec_briefs_owner_check', array['exec', 'legacy', 'exec_page_only']),
      ('exec_briefs', 'exec_briefs_owner_reason_check', array['owner_reason']),
      ('exec_briefs', 'exec_briefs_mode_check', array['ai', 'deterministic']),
      ('exec_briefs', 'exec_briefs_mode_reason_check',
       array['refused', 'truncated', 'budget', 'invalid_output', 'model_error', 'timeout']),
      ('exec_briefs', 'exec_briefs_content_check', array['content', '262144']),
      ('exec_briefs', 'exec_briefs_ref_threads_check', array['ref_thread_ids', '400']),
      ('exec_briefs', 'exec_briefs_ref_slack_keys_check', array['ref_slack_keys', '400']),
      ('exec_briefs', 'exec_briefs_ref_slack_channels_check', array['ref_slack_channels', '200']),
      ('exec_briefs', 'exec_briefs_regen_seq_check', array['regen_seq', '100000']),
      -- M2's "never a third post": BETWEEN 0 AND 2 is stored as two comparisons.
      ('exec_briefs', 'exec_briefs_post_attempts_check', array['post_attempts >= 0', 'post_attempts <= 2']),
      ('exec_briefs', 'exec_briefs_channel_check', array['slack_channel_id']),
      ('exec_briefs', 'exec_briefs_ts_check', array['slack_ts']),
      ('exec_briefs', 'exec_briefs_checkins_ts_check', array['checkins_ts']),
      ('exec_briefs', 'exec_briefs_late_ts_check', array['late_note_ts']),
      ('exec_briefs', 'exec_briefs_fallback_ts_check', array['fallback_slack_ts']),
      ('exec_briefs', 'exec_briefs_fallback_channel_check', array['fallback_channel_id']),
      ('exec_briefs', 'exec_briefs_fallback_error_check', array['fallback_error_code']),
      ('exec_briefs', 'exec_briefs_error_code_check', array['error_code']),
      ('exec_briefs', 'exec_briefs_delivered_check', array['delivered', 'delivered_at']),
      ('exec_briefs', 'exec_briefs_delivered_refs_check', array['delivered_at', 'slack_ts', 'slack_channel_id']),
      ('exec_briefs', 'exec_briefs_delivering_check', array['delivering', 'delivery_unknown', 'delivery_started_at', 'post_attempts']),
      ('exec_briefs', 'exec_briefs_content_presence_check', array['content', 'building', 'failed', 'content_purged_at']),
      ('exec_briefs', 'exec_briefs_content_purged_check', array['content_purged_at', 'content']),
      ('exec_briefs', 'exec_briefs_mode_pair_check', array['mode', 'built_at']),
      ('exec_briefs', 'exec_briefs_fallback_pair_check', array['fallback_slack_ts', 'fallback_error_code', 'fallback_sent_at']),
      ('exec_briefs', 'exec_briefs_fallback_dm_check',
       array['fallback_slack_ts', 'fallback_channel_id', 'fallback_delete_after', 'fallback_deleted_at']),
      ('exec_briefs', 'exec_briefs_late_note_check', array['late_note_ts', 'fallback_sent_at']),
      ('exec_briefs', 'exec_briefs_checkins_msg_check', array['checkins_ts', 'delivered_at', 'late_note_ts']),
      ('exec_briefs', 'exec_briefs_expiry_check', array['expires_at', 'content_expires_at']),
      ('exec_brief_checkins', 'exec_brief_checkins_id_check', array['id', 'ebc_']),
      ('exec_brief_checkins', 'exec_brief_checkins_brief_rev_check', array['brief_rev', '10000']),
      ('exec_brief_checkins', 'exec_brief_checkins_rev_check', array['rev', '1000']),
      ('exec_brief_checkins', 'exec_brief_checkins_slack_user_check', array['recipient_slack_id']),
      ('exec_brief_checkins', 'exec_brief_checkins_text_check', array['text', '600']),
      ('exec_brief_checkins', 'exec_brief_checkins_status_check', array['proposed', 'sending', 'sent', 'unknown', 'failed', 'expired']),
      ('exec_brief_checkins', 'exec_brief_checkins_reason_check', array['status_reason']),
      ('exec_brief_checkins', 'exec_brief_checkins_channel_check', array['slack_channel_id']),
      ('exec_brief_checkins', 'exec_brief_checkins_ts_check', array['slack_ts']),
      ('exec_brief_checkins', 'exec_brief_checkins_sent_check', array['sent', 'sent_at']),
      ('exec_brief_checkins', 'exec_brief_checkins_sent_refs_check', array['sent', 'slack_ts', 'slack_channel_id']),
      ('exec_brief_checkins', 'exec_brief_checkins_sending_check', array['sending', 'sent', 'unknown', 'sending_at', 'audit_id']),
      ('exec_brief_checkins', 'exec_brief_checkins_window_check', array['expires_at', 'created_at', 'purge_at']),
      ('exec_brief_mentions', 'exec_brief_mentions_fp_check', array['fingerprint', '300']),
      ('exec_brief_mentions', 'exec_brief_mentions_state_check', array['last_state_hash', '128']),
      ('exec_brief_mentions', 'exec_brief_mentions_band_check', array['critical', 'high', 'normal'])
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
    ('primary key: exec_briefs', 'exec_briefs', 'exec_briefs_pkey', 'p', array['id']),
    ('primary key: exec_brief_checkins', 'exec_brief_checkins', 'exec_brief_checkins_pkey', 'p', array['id']),
    ('primary key: exec_brief_mentions', 'exec_brief_mentions', 'exec_brief_mentions_pkey', 'p', array['principal_id', 'fingerprint']),
    ('unique: exec_briefs_day_key (principal_id, local_date)', 'exec_briefs', 'exec_briefs_day_key', 'u', array['principal_id', 'local_date'])
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
  -- Matched by columns (the inline references are auto-named): the table's FK on exactly these columns.
  select 'FK on delete cascade: ' || e.tbl || ' (' || array_to_string(e.cols, ', ') || ') -> ' || e.ref,
         coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_briefs', array['principal_id'], 'exec_principals', array['id']),
    ('exec_brief_checkins', array['brief_id'], 'exec_briefs', array['id']),
    ('exec_brief_checkins', array['principal_id'], 'exec_principals', array['id']),
    ('exec_brief_checkins', array['recipient_user_id'], 'users', array['id']),
    ('exec_brief_mentions', array['principal_id'], 'exec_principals', array['id'])
  ) e(tbl, cols, ref, refcols)
  left join lateral (
    select bool_or(k.confrelid = to_regclass('public.' || e.ref) and k.confdeltype = 'c' and c.refcols = e.refcols) as ok,
           string_agg('references ' || k.confrelid::regclass::text || ' (' || array_to_string(c.refcols, ', ') || ') on delete '
                      || k.confdeltype::text, '; ') as found
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
    ('exec_briefs', 'exec_briefs_day_key', 'btree (principal_id, local_date)', true),
    ('exec_briefs', 'exec_briefs_threads_gin', 'gin (ref_thread_ids)', false),
    ('exec_briefs', 'exec_briefs_slack_keys_gin', 'gin (ref_slack_keys)', false),
    ('exec_briefs', 'exec_briefs_slack_channels_gin', 'gin (ref_slack_channels)', false),
    ('exec_briefs', 'exec_briefs_content_expiry_idx', 'btree (content_expires_at) WHERE (content IS NOT NULL)', false),
    ('exec_briefs', 'exec_briefs_expiry_idx', 'btree (expires_at)', false),
    ('exec_briefs', 'exec_briefs_open_idx',
     'btree (principal_id, local_date) WHERE (status = ANY (ARRAY[''building''::text, ''built''::text, ''delivering''::text]))', false),
    ('exec_briefs', 'exec_briefs_followup_idx', 'btree (principal_id) WHERE ((scrubbed_at IS NOT NULL) AND (delivered_at IS NOT NULL))', false),
    ('exec_briefs', 'exec_briefs_fallback_dm_idx',
     'btree (fallback_delete_after) WHERE ((fallback_slack_ts IS NOT NULL) AND (fallback_deleted_at IS NULL))', false),
    ('exec_brief_checkins', 'exec_brief_checkins_live_key', 'btree (brief_id, recipient_user_id) WHERE (status <> ''expired''::text)', true),
    ('exec_brief_checkins', 'exec_brief_checkins_day_idx', 'btree (principal_id, local_date, status)', false),
    ('exec_brief_checkins', 'exec_brief_checkins_slack_ts_idx', 'btree (principal_id, slack_ts) WHERE (slack_ts IS NOT NULL)', false),
    ('exec_brief_checkins', 'exec_brief_checkins_recipient_idx', 'btree (recipient_user_id, created_at DESC)', false),
    ('exec_brief_checkins', 'exec_brief_checkins_brief_idx', 'btree (brief_id)', false),
    ('exec_brief_checkins', 'exec_brief_checkins_purge_idx', 'btree (purge_at)', false),
    ('exec_brief_mentions', 'exec_brief_mentions_ttl_idx', 'btree (last_mentioned_on)', false)
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
    ('exec_brief_item_hit(jsonb,text[],text[],text[],boolean)'),
    ('exec_brief_scrub_content(jsonb,text[],text[],text[],boolean,text)'),
    ('exec_brief_ref_array(jsonb,text)'),
    ('exec_brief_claim_build(text,date,text,timestamptz,text,integer,timestamptz,timestamptz,integer)'),
    ('exec_brief_finish_build(text,integer,text,text,text,text,text,text,text,jsonb,text[],text[],text[],jsonb,date)'),
    ('exec_brief_delivery_step(text,text[],text,boolean,text,text,text,text)'),
    ('exec_brief_claim_fallback(text,date,text,timestamptz,timestamptz,timestamptz)'),
    ('exec_brief_scrub_threads(text,text[])'),
    ('exec_brief_scrub_slack(text,text[],text[],boolean)'),
    ('exec_brief_purge_expired(timestamptz,integer,date)'),
    ('exec_slack_accept_action_v2(text,text,text,text,text,text,text,text,text)')
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
  from (values ('exec_brief_item_hit'), ('exec_brief_scrub_content'), ('exec_brief_ref_array'), ('exec_brief_claim_build'),
               ('exec_brief_finish_build'), ('exec_brief_delivery_step'), ('exec_brief_claim_fallback'), ('exec_brief_scrub_threads'),
               ('exec_brief_scrub_slack'), ('exec_brief_purge_expired'), ('exec_slack_accept_action_v2')) e(name)
  cross join lateral (
    select count(*)::int as n, string_agg(p.oid::regprocedure::text, '; ') as sigs
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = e.name
  ) x
  union all
  select 'immutable: ' || e.fn, coalesce(x.vol = 'i', false), case when not coalesce(x.vol = 'i', false) then coalesce('provolatile ' || x.vol, '(missing)') end
  from (values ('exec_brief_item_hit(jsonb,text[],text[],text[],boolean)'), ('exec_brief_scrub_content(jsonb,text[],text[],text[],boolean,text)'),
               ('exec_brief_ref_array(jsonb,text)')) e(fn)
  left join lateral (select p.provolatile::text as vol from pg_proc p where p.oid = to_regprocedure('public.' || e.fn)) x on true
  union all
  -- intel-14: a scrub that changed anything nulls the headline and says so.
  select 'nulls the headline (intel-14): exec_brief_scrub_content', coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (select 1) one
  left join lateral (
    select strpos(p.prosrc, 'headlineScrubbed') > 0 and strpos(p.prosrc, '''headline'', null') > 0 as ok,
           'prosrc lacks headlineScrubbed or the nulled headline' as found
    from pg_proc p where p.oid = to_regprocedure('public.exec_brief_scrub_content(jsonb,text[],text[],text[],boolean,text)')
  ) x on true
  union all
  -- C43 / intel-17: v2 holds the check-in branch (one job per click) and P6's own path survived the copy.
  select 'check-in branch and P6 path (C43): exec_slack_accept_action_v2', coalesce(x.missing is null and x.found, false),
         case when not coalesce(x.missing is null and x.found, false) then coalesce('prosrc lacks: ' || x.missing, '(missing)') end
  from (select 1) one
  left join lateral (
    select true as found,
           (select string_agg(w, ', ') from unnest(array[
              '''ea_ci_send''', '''ea_ci_rewrite''', '''exec.checkin-send''', '''exec.checkin-rewrite''',
              '''checkin-send:'' else ''checkin-rewrite:'' end) || p_trigger_id',
              '''exec.slack-action''', '''slack-act:'' || p_trigger_id', '''ea_draft_save''', '''ea_fb_down''']) w
             where strpos(p.prosrc, w) = 0) as missing
    from pg_proc p where p.oid = to_regprocedure('public.exec_slack_accept_action_v2(text,text,text,text,text,text,text,text,text)')
  ) x on true
  union all
  -- C43: P8 never touches P6's v1 (the fallback while v2 is missing): present, P6's path, no check-in action in it.
  select 'still present and P6''s (C43): exec_slack_accept_action(text x 9)', coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (select 1) one
  left join lateral (
    select strpos(p.prosrc, '''slack-act:'' || p_trigger_id') > 0 and strpos(p.prosrc, 'ea_ci_') = 0 as ok,
           case when strpos(p.prosrc, 'ea_ci_') > 0 then 'holds a check-in action (P6''s function was redefined)'
                else 'lacks P6''s enqueue' end as found
    from pg_proc p where p.oid = to_regprocedure('public.exec_slack_accept_action(text,text,text,text,text,text,text,text,text)')
  ) x on true
  union all
  -- AM-P8-2: P8 redefines no earlier CHECK; P6's ledger CHECKs keep P6's kinds and ref shapes.
  select 'P6''s ledger CHECKs untouched: exec_slack_posts', coalesce(x.bad is null and x.n = 4, false),
         case when not coalesce(x.bad is null and x.n = 4, false) then coalesce(x.bad, x.n::text || ' of the 4 CHECKs present') end
  from (select 1) one
  left join lateral (
    select count(*)::int as n,
           string_agg(case
             when pc.conname = 'exec_slack_posts_kind_check'
                  and (pg_get_constraintdef(pc.oid) !~ '\manswer\M' or pg_get_constraintdef(pc.oid) !~ '\mnote\M'
                       or pg_get_constraintdef(pc.oid) !~ '\mdraft\M' or pg_get_constraintdef(pc.oid) !~ '\mproposal\M'
                       or pg_get_constraintdef(pc.oid) ~ '\mbrief\M' or pg_get_constraintdef(pc.oid) ~ '\mcheckins\M')
               then pc.conname || ': ' || pg_get_constraintdef(pc.oid)
             when pc.conname = 'exec_slack_posts_ref_shape_check' and strpos(pg_get_constraintdef(pc.oid), '^(ed|etp)_') = 0
               then pc.conname || ': ' || pg_get_constraintdef(pc.oid)
             when pc.conname in ('exec_slack_posts_ref_check', 'exec_slack_posts_ref_kind_check')
                  and pg_get_constraintdef(pc.oid) ~ '\m(brief|checkins|eb_)\M'
               then pc.conname || ': ' || pg_get_constraintdef(pc.oid)
           end, '; ') as bad
    from pg_constraint pc
    where pc.conrelid = to_regclass('public.exec_slack_posts') and pc.contype = 'c'
      and pc.conname in ('exec_slack_posts_kind_check', 'exec_slack_posts_ref_shape_check', 'exec_slack_posts_ref_check',
                         'exec_slack_posts_ref_kind_check')
  ) x on true
  union all
  select 'relies on (' || e.phase || '): column ' || e.tbl || '.' || e.col, x.typ is not null,
         case when x.typ is null then '(missing)' end
  from (values
    ('P6', 'exec_slack_installations', 'user_id'), ('P6', 'exec_slack_installations', 'team_id'),
    ('P6', 'exec_slack_installations', 'app_id'), ('P6', 'exec_slack_installations', 'slack_dm_channel_id'),
    ('P6', 'exec_slack_installations', 'installed_at'), ('P6', 'exec_slack_installations', 'revoked_at'),
    ('P6', 'exec_slack_posts', 'ref_id'), ('P2a', 'exec_jobs', 'dedupe_key'),
    ('DD', 'users', 'id'), ('DD', 'daily_briefings', 'delivered_at'), ('DD', 'daily_briefings', 'messages'),
    ('DD', 'daily_briefings', 'meta')
  ) e(phase, tbl, col)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) as typ from pg_attribute a
     where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = e.col and a.attnum > 0 and not a.attisdropped
  ) x on true
  union all
  select 'relies on (P3): table exec_email_threads', to_regclass('public.exec_email_threads') is not null,
         case when to_regclass('public.exec_email_threads') is null then '(missing)' end
) checks
order by ok, check_name;
