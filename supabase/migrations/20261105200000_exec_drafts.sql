-- Executive AI Assistant — P4 drafts, save to Outlook, send on confirm, voice.
--
--   exec_settings.drafts_enabled  generate, edit and save drafts to Outlook (default false)
--   exec_settings.send_enabled    send a reviewed Outlook draft (default false)
--   exec_settings.voice_enabled   the weekly style profile (default true; runs only while drafts are on)
--   exec_drafts                   one row per assistant draft: his draft text, recipients, the
--                                 Outlook link, the review and send attempt, the reconcile schedule.
--                                 A named carve-out from P3's "no bodies in DD tables" rule: it holds
--                                 his own draft text under retention, and the restricted purge
--                                 empties it (the content CHECK below).
--   exec_voice_profile            one row per principal: style enums and a short sign-off, no free text.
--
-- RPCs (SECURITY INVOKER, search_path '', EXECUTE for service_role only, like the P2a/P3 RPCs):
--   exec_drafts_purge_restricted  empties the drafts of threads that turned restricted
--   exec_drafts_purge_expired     the daily retention pass
--
-- Security: RLS ON with NO policies and nothing granted to anon/authenticated, like every exec_
-- table. Nothing reads these tables until EXEC_ENABLED=true and drafts_enabled=true, and the app
-- tolerates this file being applied late (drafts stay off), so applying it early is harmless.
--
-- Idempotent. Apply MANUALLY in the Supabase SQL editor, AFTER 20261105100000_exec_email.sql.
-- Turning drafts on, then send, is two hand-run scripts afterwards
-- (supabase/scripts/20261105_exec_p4_enable_drafts.sql, then 20261105_exec_p4_enable_send.sql).

set local lock_timeout = '5s';

-- Pre-flight: P2a, P2b and P3 must be applied first. Aborts before changing anything.
do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_settings') is null
     or to_regclass('public.exec_audit_log') is null then
    raise exception 'exec drafts aborted, nothing changed: the P2a foundation is missing (apply 20261104100000_exec_foundation.sql first)';
  end if;
  if to_regclass('public.exec_attention_items') is null then
    raise exception 'exec drafts aborted, nothing changed: public.exec_attention_items does not exist (apply 20261104200000_exec_attention.sql first)';
  end if;
  if to_regclass('public.exec_email_threads') is null or not exists (
       select 1 from pg_attribute
        where attrelid = 'public.exec_settings'::regclass and attname = 'email_enabled' and not attisdropped) then
    raise exception 'exec drafts aborted, nothing changed: the P3 email migration is missing (apply 20261105100000_exec_email.sql first)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The switches
-- ---------------------------------------------------------------------------

alter table public.exec_settings add column if not exists drafts_enabled boolean not null default false;
alter table public.exec_settings add column if not exists send_enabled   boolean not null default false;
alter table public.exec_settings add column if not exists voice_enabled  boolean not null default true;

-- ---------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------

create table if not exists public.exec_drafts (
  id                   text primary key default ('ed_' || replace(gen_random_uuid()::text, '-', ''))
                         check (id ~ '^ed_[0-9a-f]{32}$'),
  principal_id         text not null references public.exec_principals(id) on delete cascade,
  account_id           text not null check (char_length(account_id) between 1 and 200),
  kind                 text not null check (kind in ('reply', 'new')),
  origin               text not null default 'web' check (origin in ('web', 'slack', 'chat')),
  status               text not null check (status in ('generating', 'generation_failed', 'draft', 'saving', 'saved',
                         'sending', 'sent_pending', 'unknown', 'sent', 'sent_external', 'gone', 'discarding', 'discarded')),
  -- Where a regenerate or a discard started (C6, C76); see exec_drafts_prior.
  prior_status         text check (prior_status is null or prior_status in ('draft', 'saved', 'generation_failed', 'unknown')),
  version              integer not null default 1 check (version >= 1),
  saved_version        integer check (saved_version is null or saved_version >= 1),
  generation_seq       integer not null default 0 check (generation_seq >= 0),

  -- Source thread (reply drafts). Metadata: kept by both purges.
  thread_id            text check (thread_id is null or thread_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  parent_message_id    text check (parent_message_id is null or parent_message_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  reply_mode           text check (reply_mode is null or reply_mode in ('reply', 'reply_all', 'follow_up')),

  -- Content: emptied by the retention purge and by the restricted purge (exec_drafts_content_purged).
  thread_subject       text check (thread_subject is null or char_length(thread_subject) <= 200),
  reply_candidates     jsonb check (reply_candidates is null or jsonb_typeof(reply_candidates) = 'object'),
  thread_addresses     text[] not null default '{}' check (cardinality(thread_addresses) <= 200),
  to_recipients        jsonb not null default '[]'::jsonb check (jsonb_typeof(to_recipients) = 'array'),
  cc_recipients        jsonb not null default '[]'::jsonb check (jsonb_typeof(cc_recipients) = 'array'),
  bcc_recipients       jsonb not null default '[]'::jsonb check (jsonb_typeof(bcc_recipients) = 'array'),
  subject              text check (subject is null or (char_length(subject) between 1 and 998
                         and position(chr(10) in subject) = 0 and position(chr(13) in subject) = 0)),
  body_doc             jsonb check (body_doc is null or (jsonb_typeof(body_doc) = 'object' and octet_length(body_doc::text) <= 65536)),
  body_html            text check (body_html is null or char_length(body_html) <= 1000000),
  body_text            text check (body_text is null or char_length(body_text) <= 20000),
  instruction          text check (instruction is null or char_length(instruction) <= 2000),
  note_for_mitchell    text check (note_for_mitchell is null or char_length(note_for_mitchell) <= 400),
  placeholders         text[] not null default '{}' check (cardinality(placeholders) <= 20),
  review_recipients    jsonb check (review_recipients is null or jsonb_typeof(review_recipients) = 'object'),

  -- Recipient-set signature (C10) and screening (C11). Metadata.
  recipients_sig       text check (recipients_sig is null or recipients_sig ~ '^[0-9a-f]{64}$'),
  screen_hashes        text[] not null default '{}' check (cardinality(screen_hashes) <= 600),
  screen_truncated     boolean not null default false,
  -- restrictedPolicyHash of the rules the hashes were last written under (P3's screenStoredRow input).
  screened_policy_hash text check (screened_policy_hash is null or screened_policy_hash ~ '^[0-9a-f]{64}$'),

  -- Generation metadata. render_nonce: P3's triage renderer accepts [A-Za-z0-9]{16,64} (bindings AM7).
  render_nonce         text not null check (render_nonce ~ '^[A-Za-z0-9]{16,64}$'),
  model                text check (model is null or char_length(model) <= 64),
  usage                jsonb check (usage is null or jsonb_typeof(usage) = 'object'),
  generation_error     text check (generation_error is null or generation_error in ('declined', 'truncated', 'invalid_output',
                         'budget', 'input_too_large', 'thread_unavailable', 'restricted', 'model_error', 'timeout', 'stale', 'stopped')),
  -- The output scan's codes (C65); never the flagged values.
  generation_flags     text[] not null default '{}' check (generation_flags <@ array['unexpected_url', 'unexpected_email',
                         'unexpected_phone', 'unexpected_amount', 'unexpected_number', 'other_client_name', 'teammate_name']::text[]),
  facts_status         text check (facts_status is null or facts_status in ('used', 'none', 'not_matched', 'medium_confidence',
                         'unavailable', 'recipients_outside_client')),
  client_id            text check (client_id is null or char_length(client_id) <= 200),
  generated_at         timestamptz,

  -- The Outlook link (CL2 read-back). The length bound sits outside the regex: Postgres caps a
  -- regex repetition count at 255, and a bound of 512 would raise 2201B on the first non-null value.
  outlook_graph_id     text check (outlook_graph_id is null or (char_length(outlook_graph_id) between 1 and 512
                         and outlook_graph_id ~ '^[A-Za-z0-9_=-]+$')),
  internet_message_id  text check (internet_message_id is null or char_length(internet_message_id) between 1 and 998),
  conversation_id      text check (conversation_id is null or char_length(conversation_id) <= 512),
  web_link             text check (web_link is null or (char_length(web_link) <= 4096 and web_link ~ '^https://')),

  -- Hashes (the clone computes them; DD never hashes the draft).
  -- content_hash: the read-back he was shown or DD's own save produced; the ifContentHash guard (C66).
  content_hash         text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  -- observed_content_hash: the latest read-back hash from a read he didn't see (sweep, idle check, Check again).
  observed_content_hash text check (observed_content_hash is null or observed_content_hash ~ '^[0-9a-f]{64}$'),
  review_hash          text check (review_hash is null or review_hash ~ '^[0-9a-f]{64}$'),
  review_at            timestamptz,
  review_blockers      text[] not null default '{}' check (review_blockers <@ array['already_replied', 'newer_inbound',
                         'reply_scheduled', 'legacy_draft_pending', 'opened_in_outlook', 'changed_in_outlook',
                         'recipients_changed', 'reply_to_present', 'placeholder_in_outlook', 'thread_unavailable',
                         'facts_outside_client', 'unexpected_content']::text[]),
  confirm_hash         text check (confirm_hash is null or confirm_hash ~ '^[0-9a-f]{64}$'),

  -- Attempts.
  save_attempt_key     text check (save_attempt_key is null or save_attempt_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  save_version         integer check (save_version is null or save_version >= 1),
  save_timezone        text check (save_timezone is null or char_length(save_timezone) <= 64),
  -- The exact ifContentHash a recreate sent (T17), so a replay is byte-identical (C14).
  save_if_content_hash text check (save_if_content_hash is null or save_if_content_hash ~ '^[0-9a-f]{64}$'),
  save_started_at      timestamptz,
  discard_attempt_key  text check (discard_attempt_key is null or discard_attempt_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  discard_started_at   timestamptz,
  send_attempt_key     text check (send_attempt_key is null or send_attempt_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  send_started_at      timestamptz,
  send_accepted_at     timestamptz,
  sent_at              timestamptz,
  -- Audit rows are purged after 400 days (handlers/purge.ts RETENTION_DAYS.auditLog): the link must not block that.
  sent_audit_id        bigint references public.exec_audit_log(id) on delete set null,

  -- Flags.
  sent_mismatch        boolean not null default false,
  unverified           boolean not null default false,
  gone_unconfirmed     boolean not null default false,
  signature_skipped    boolean not null default false,
  outlook_edited       boolean not null default false,
  restricted_purged    boolean not null default false,
  uses_private_refs    boolean not null default false,
  clone_flags          text[] not null default '{}' check (clone_flags <@ array['send_status_unknown', 'not_found_after_send',
                         'verify_overdue', 'create_unconfirmed', 'gone_unconfirmed', 'unverified', 'signature_skipped']::text[]),
  owner_resolution     text check (owner_resolution is null or owner_resolution in ('sent', 'not_sent')),
  opened_in_outlook_at timestamptz,
  last_error_code      text check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  last_error_at        timestamptz,

  -- Reconcile schedule.
  next_check_at        timestamptz,
  check_count          integer not null default 0 check (check_count between 0 and 10000),
  gone_at              timestamptz,

  -- Lifecycle.
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  terminal_at          timestamptz,
  content_purged_at    timestamptz,
  expires_at           timestamptz,

  constraint exec_drafts_kind_shape check (
    (kind = 'reply' and thread_id is not null and parent_message_id is not null and reply_mode is not null
       and subject is null and jsonb_array_length(bcc_recipients) = 0)
    or (kind = 'new' and thread_id is null and parent_message_id is null and reply_mode is null
       and thread_subject is null and reply_candidates is null)),
  constraint exec_drafts_recipient_count check (
    jsonb_array_length(to_recipients) + jsonb_array_length(cc_recipients) + jsonb_array_length(bcc_recipients) <= 20),
  constraint exec_drafts_versions check (saved_version is null or saved_version <= version),
  constraint exec_drafts_prior check (
    prior_status is null
    or (status = 'generating' and prior_status in ('draft', 'saved', 'generation_failed'))
    or (status = 'discarding' and prior_status in ('draft', 'saved', 'unknown'))),
  constraint exec_drafts_linked check (
    status not in ('saved', 'sending', 'sent_pending', 'unknown', 'discarding', 'sent', 'sent_external', 'gone')
    or outlook_graph_id is not null),
  constraint exec_drafts_terminal check ((status in ('sent', 'sent_external', 'gone', 'discarded')) = (terminal_at is not null)),
  constraint exec_drafts_expiry check ((terminal_at is null) = (expires_at is null)),
  constraint exec_drafts_content_purged check (
    (not restricted_purged and content_purged_at is null) or (
      thread_subject is null and reply_candidates is null and cardinality(thread_addresses) = 0
      and to_recipients = '[]'::jsonb and cc_recipients = '[]'::jsonb and bcc_recipients = '[]'::jsonb
      and subject is null and body_doc is null and body_html is null and body_text is null
      and instruction is null and note_for_mitchell is null and cardinality(placeholders) = 0
      and review_recipients is null)),
  constraint exec_drafts_content_purged_when check (content_purged_at is null or terminal_at is not null or restricted_purged),
  constraint exec_drafts_review_pair check ((review_hash is null) = (review_at is null)),
  constraint exec_drafts_save_attempt check (status <> 'saving'
    or (save_attempt_key is not null and save_version is not null and save_started_at is not null)),
  constraint exec_drafts_send_attempt check (status <> 'sending'
    or (send_attempt_key is not null and send_started_at is not null and confirm_hash is not null)),
  constraint exec_drafts_discard_attempt check (status <> 'discarding'
    or (discard_attempt_key is not null and discard_started_at is not null and prior_status is not null)),
  constraint exec_drafts_gone check ((status <> 'gone' or gone_at is not null) and (not gone_unconfirmed or status = 'gone')),
  constraint exec_drafts_resolution check (owner_resolution is null or status in ('sent', 'discarded'))
);

-- One active draft per (principal, thread) (L16). A gone draft whose deletion isn't confirmed yet
-- still counts (C17): it may have been sent from Outlook.
create unique index if not exists exec_drafts_one_active_per_thread on public.exec_drafts (principal_id, thread_id)
  where thread_id is not null
    and (status in ('generating', 'generation_failed', 'draft', 'saving', 'saved', 'sending', 'sent_pending', 'unknown', 'discarding')
         or (status = 'gone' and gone_unconfirmed));
-- Lists and the Drafts bucket.
create index if not exists exec_drafts_list_idx on public.exec_drafts (principal_id, status, updated_at desc);
-- Reply artifacts and the thread page.
create index if not exists exec_drafts_thread_idx on public.exec_drafts (principal_id, thread_id) where thread_id is not null;
-- The reconcile sweep.
create index if not exists exec_drafts_due_idx on public.exec_drafts (principal_id, next_check_at) where next_check_at is not null;
-- The retention pass.
create index if not exists exec_drafts_content_purge_idx on public.exec_drafts (terminal_at)
  where terminal_at is not null and content_purged_at is null;
create index if not exists exec_drafts_expires_idx on public.exec_drafts (expires_at) where expires_at is not null;
-- The voice sample excludes the assistant's own sends.
create index if not exists exec_drafts_imid_idx on public.exec_drafts (principal_id, internet_message_id)
  where internet_message_id is not null;
-- ON DELETE SET NULL from the audit purge.
create index if not exists exec_drafts_sent_audit_idx on public.exec_drafts (sent_audit_id) where sent_audit_id is not null;

-- ---------------------------------------------------------------------------
-- Voice profile
-- ---------------------------------------------------------------------------

create table if not exists public.exec_voice_profile (
  principal_id       text primary key references public.exec_principals(id) on delete cascade,
  status             text not null check (status in ('ready', 'insufficient', 'failed')),
  formality          text check (formality is null or formality in ('very_casual', 'casual', 'neutral', 'formal')),
  typical_length     text check (typical_length is null or typical_length in ('one_liner', 'short', 'medium', 'long')),
  greeting           text check (greeting is null or greeting in ('none', 'hi_first_name', 'hey_first_name', 'hello_first_name',
                       'first_name_only', 'dear_name', 'mixed')),
  paragraphing       text check (paragraphing is null or paragraphing in ('single_block', 'short_paragraphs', 'many_short_lines')),
  bullets            text check (bullets is null or bullets in ('never', 'sometimes', 'often')),
  emoji              text check (emoji is null or emoji in ('never', 'rarely', 'sometimes')),
  sign_off           text check (sign_off is null or sign_off ~ '^[A-Za-z][A-Za-z ,.!''-]{0,39}$'),
  sample_count       integer not null default 0 check (sample_count between 0 and 40),
  samples_hash       text check (samples_hash is null or samples_hash ~ '^[0-9a-f]{64}$'),
  window_days        integer not null default 90 check (window_days between 1 and 365),
  model              text check (model is null or char_length(model) <= 64),
  prompt_version     text not null check (char_length(prompt_version) between 1 and 40),
  built_at           timestamptz not null,
  last_attempt_at    timestamptz,
  last_attempt_error text check (last_attempt_error is null or last_attempt_error in ('declined', 'truncated', 'invalid_output',
                       'budget', 'input_too_large', 'read_failed', 'feed_unsupported')),
  updated_at         timestamptz not null default now(),
  constraint exec_voice_profile_ready check (status <> 'ready' or (formality is not null and typical_length is not null
    and greeting is not null and paragraphing is not null and bullets is not null and emoji is not null))
);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Empty the drafts of threads that turned restricted (L12, C12). Called by P3's tombstone
-- procedure, both attention safety nets and P4's own screens. Per row: a draft with no Outlook
-- link that is generating, failed or a plain draft is closed as discarded; a linked draft that is
-- generating goes back to its prior status; every other status is kept, so an Outlook draft stays
-- tracked and can be deleted. Content is nulled, the review cleared, version bumped (fencing any
-- writer that read the row before), restricted_purged set. A discarding row keeps its prior_status
-- (exec_drafts_discard_attempt needs it, C76). Idempotent. Returns the rows changed.
-- The CASEs read the row as UPDATE sees it, so a concurrent status change is never undone.
create or replace function public.exec_drafts_purge_restricted(p_principal text, p_thread_ids text[])
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
    raise exception 'exec_drafts_purge_restricted: p_principal is required';
  end if;
  if p_thread_ids is null or cardinality(p_thread_ids) = 0 then
    return 0;
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
           version = d.version + 1,
           updated_at = now()
     where d.principal_id = p_principal
       and d.thread_id = any(p_thread_ids)
       and not d.restricted_purged
    returning 1
  )
  select count(*)::int into n from u;
  return n;
end;
$$;

-- The daily retention pass (L20, C41), across all principals, at most p_limit rows per step:
--   1. content of terminal rows 30 days after they ended;
--   2. whole rows whose metadata retention (retention_days_email after the end) has passed;
--   3. DD-only drafts untouched for 30 days are closed (expired_idle);
--   4. linked non-terminal drafts untouched for 30 days whose schedule has ended get one reconcile
--      check (draft, saved, unknown, and gone while unconfirmed: C41, C68).
-- Never deletes a non-terminal row. Returns {contentPurged, deleted, closedIdle, checksScheduled}.
create or replace function public.exec_drafts_purge_expired(p_now timestamptz, p_limit integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  n_content integer;
  n_deleted integer;
  n_idle integer;
  n_checks integer;
begin
  if p_now is null then
    raise exception 'exec_drafts_purge_expired: p_now is required';
  end if;

  with t as (
    select d.id from public.exec_drafts d
     where d.terminal_at is not null and d.content_purged_at is null and d.terminal_at < p_now - interval '30 days'
     order by d.terminal_at limit v_limit
  ), u as (
    update public.exec_drafts d
       set thread_subject = null, reply_candidates = null, thread_addresses = '{}',
           to_recipients = '[]'::jsonb, cc_recipients = '[]'::jsonb, bcc_recipients = '[]'::jsonb,
           subject = null, body_doc = null, body_html = null, body_text = null,
           instruction = null, note_for_mitchell = null, placeholders = '{}', review_recipients = null,
           content_purged_at = p_now, updated_at = p_now
      from t
     where d.id = t.id and d.content_purged_at is null and d.terminal_at is not null
    returning 1
  )
  select count(*)::int into n_content from u;

  with t as (
    select d.id from public.exec_drafts d
     where d.expires_at is not null and d.expires_at < p_now and d.terminal_at is not null
     order by d.expires_at limit v_limit
  ), x as (
    delete from public.exec_drafts d using t where d.id = t.id and d.terminal_at is not null returning 1
  )
  select count(*)::int into n_deleted from x;

  with t as (
    select d.id from public.exec_drafts d
     where d.outlook_graph_id is null and d.status in ('draft', 'generation_failed') and d.updated_at < p_now - interval '30 days'
     order by d.updated_at limit v_limit
  ), u as (
    update public.exec_drafts d
       set status = 'discarded', terminal_at = p_now,
           expires_at = p_now + make_interval(days => coalesce(
             (select s.retention_days_email from public.exec_settings s where s.principal_id = d.principal_id), 180)),
           next_check_at = null, last_error_code = 'expired_idle', last_error_at = p_now,
           version = d.version + 1, updated_at = p_now
      from t
     where d.id = t.id and d.outlook_graph_id is null and d.status in ('draft', 'generation_failed')
    returning 1
  )
  select count(*)::int into n_idle from u;

  with t as (
    select d.id from public.exec_drafts d
     where d.outlook_graph_id is not null and d.next_check_at is null
       and (d.status in ('draft', 'saved', 'unknown') or (d.status = 'gone' and d.gone_unconfirmed))
       and d.updated_at < p_now - interval '30 days'
     order by d.updated_at limit v_limit
  ), u as (
    update public.exec_drafts d set next_check_at = p_now
      from t where d.id = t.id and d.next_check_at is null
    returning 1
  )
  select count(*)::int into n_checks from u;

  return jsonb_build_object('contentPurged', n_content, 'deleted', n_deleted, 'closedIdle', n_idle, 'checksScheduled', n_checks);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, no policies; service_role only
-- ---------------------------------------------------------------------------

alter table public.exec_drafts        enable row level security;
alter table public.exec_voice_profile enable row level security;
revoke all on public.exec_drafts, public.exec_voice_profile from public, anon, authenticated;
grant all on public.exec_drafts, public.exec_voice_profile to service_role;

revoke all on function public.exec_drafts_purge_restricted(text, text[]) from public, anon, authenticated;
revoke all on function public.exec_drafts_purge_expired(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.exec_drafts_purge_restricted(text, text[]) to service_role;
grant execute on function public.exec_drafts_purge_expired(timestamptz, integer) to service_role;

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
--   * the three exec_settings switches: boolean, not null, their defaults;
--   * every column of exec_drafts and exec_voice_profile, with type and
--     nullability;
--   * every named CHECK (the prior and the v2 value lists by definition), and
--     a content-purge whitelist that names every content column; the partial
--     unique index (one active draft per thread) by key columns and predicate;
--   * the seven other indexes, by key columns (definitions differ across
--     Postgres versions); the principal FKs with ON DELETE CASCADE and the
--     audit FK with ON DELETE SET NULL;
--   * the two RPCs: SECURITY INVOKER with a pinned search_path.
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
  select 'column: exec_settings.' || e.col || ' boolean not null default ' || e.def,
         coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values ('drafts_enabled', 'false'), ('send_enabled', 'false'), ('voice_enabled', 'true')) e(col, def)
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = 'boolean' and a.attnotnull
             and pg_get_expr(d.adbin, d.adrelid) = e.def as ok,
           format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ' (no default)') as found
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.exec_settings'::regclass and a.attname = e.col and not a.attisdropped
  ) x on true
  union all
  select 'columns: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_drafts'), ('exec_voice_profile')) e(tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_drafts', 1, 'id', 'text', true), ('exec_drafts', 2, 'principal_id', 'text', true),
      ('exec_drafts', 3, 'account_id', 'text', true), ('exec_drafts', 4, 'kind', 'text', true),
      ('exec_drafts', 5, 'origin', 'text', true), ('exec_drafts', 6, 'status', 'text', true),
      ('exec_drafts', 7, 'prior_status', 'text', false), ('exec_drafts', 8, 'version', 'integer', true),
      ('exec_drafts', 9, 'saved_version', 'integer', false), ('exec_drafts', 10, 'generation_seq', 'integer', true),
      ('exec_drafts', 11, 'thread_id', 'text', false), ('exec_drafts', 12, 'parent_message_id', 'text', false),
      ('exec_drafts', 13, 'reply_mode', 'text', false), ('exec_drafts', 14, 'thread_subject', 'text', false),
      ('exec_drafts', 15, 'reply_candidates', 'jsonb', false), ('exec_drafts', 16, 'thread_addresses', 'text[]', true),
      ('exec_drafts', 17, 'to_recipients', 'jsonb', true), ('exec_drafts', 18, 'cc_recipients', 'jsonb', true),
      ('exec_drafts', 19, 'bcc_recipients', 'jsonb', true), ('exec_drafts', 20, 'subject', 'text', false),
      ('exec_drafts', 21, 'body_doc', 'jsonb', false), ('exec_drafts', 22, 'body_html', 'text', false),
      ('exec_drafts', 23, 'body_text', 'text', false), ('exec_drafts', 24, 'instruction', 'text', false),
      ('exec_drafts', 25, 'note_for_mitchell', 'text', false), ('exec_drafts', 26, 'placeholders', 'text[]', true),
      ('exec_drafts', 27, 'review_recipients', 'jsonb', false), ('exec_drafts', 28, 'recipients_sig', 'text', false),
      ('exec_drafts', 29, 'screen_hashes', 'text[]', true), ('exec_drafts', 30, 'screen_truncated', 'boolean', true),
      ('exec_drafts', 31, 'screened_policy_hash', 'text', false), ('exec_drafts', 32, 'render_nonce', 'text', true),
      ('exec_drafts', 33, 'model', 'text', false), ('exec_drafts', 34, 'usage', 'jsonb', false),
      ('exec_drafts', 35, 'generation_error', 'text', false), ('exec_drafts', 36, 'generation_flags', 'text[]', true),
      ('exec_drafts', 37, 'facts_status', 'text', false), ('exec_drafts', 38, 'client_id', 'text', false),
      ('exec_drafts', 39, 'generated_at', 'timestamp with time zone', false),
      ('exec_drafts', 40, 'outlook_graph_id', 'text', false), ('exec_drafts', 41, 'internet_message_id', 'text', false),
      ('exec_drafts', 42, 'conversation_id', 'text', false), ('exec_drafts', 43, 'web_link', 'text', false),
      ('exec_drafts', 44, 'content_hash', 'text', false), ('exec_drafts', 45, 'observed_content_hash', 'text', false),
      ('exec_drafts', 46, 'review_hash', 'text', false), ('exec_drafts', 47, 'review_at', 'timestamp with time zone', false),
      ('exec_drafts', 48, 'review_blockers', 'text[]', true), ('exec_drafts', 49, 'confirm_hash', 'text', false),
      ('exec_drafts', 50, 'save_attempt_key', 'text', false), ('exec_drafts', 51, 'save_version', 'integer', false),
      ('exec_drafts', 52, 'save_timezone', 'text', false), ('exec_drafts', 53, 'save_if_content_hash', 'text', false),
      ('exec_drafts', 54, 'save_started_at', 'timestamp with time zone', false),
      ('exec_drafts', 55, 'discard_attempt_key', 'text', false),
      ('exec_drafts', 56, 'discard_started_at', 'timestamp with time zone', false),
      ('exec_drafts', 57, 'send_attempt_key', 'text', false),
      ('exec_drafts', 58, 'send_started_at', 'timestamp with time zone', false),
      ('exec_drafts', 59, 'send_accepted_at', 'timestamp with time zone', false),
      ('exec_drafts', 60, 'sent_at', 'timestamp with time zone', false), ('exec_drafts', 61, 'sent_audit_id', 'bigint', false),
      ('exec_drafts', 62, 'sent_mismatch', 'boolean', true), ('exec_drafts', 63, 'unverified', 'boolean', true),
      ('exec_drafts', 64, 'gone_unconfirmed', 'boolean', true), ('exec_drafts', 65, 'signature_skipped', 'boolean', true),
      ('exec_drafts', 66, 'outlook_edited', 'boolean', true), ('exec_drafts', 67, 'restricted_purged', 'boolean', true),
      ('exec_drafts', 68, 'uses_private_refs', 'boolean', true), ('exec_drafts', 69, 'clone_flags', 'text[]', true),
      ('exec_drafts', 70, 'owner_resolution', 'text', false),
      ('exec_drafts', 71, 'opened_in_outlook_at', 'timestamp with time zone', false),
      ('exec_drafts', 72, 'last_error_code', 'text', false), ('exec_drafts', 73, 'last_error_at', 'timestamp with time zone', false),
      ('exec_drafts', 74, 'next_check_at', 'timestamp with time zone', false), ('exec_drafts', 75, 'check_count', 'integer', true),
      ('exec_drafts', 76, 'gone_at', 'timestamp with time zone', false),
      ('exec_drafts', 77, 'created_at', 'timestamp with time zone', true), ('exec_drafts', 78, 'updated_at', 'timestamp with time zone', true),
      ('exec_drafts', 79, 'terminal_at', 'timestamp with time zone', false),
      ('exec_drafts', 80, 'content_purged_at', 'timestamp with time zone', false),
      ('exec_drafts', 81, 'expires_at', 'timestamp with time zone', false),
      ('exec_voice_profile', 1, 'principal_id', 'text', true), ('exec_voice_profile', 2, 'status', 'text', true),
      ('exec_voice_profile', 3, 'formality', 'text', false), ('exec_voice_profile', 4, 'typical_length', 'text', false),
      ('exec_voice_profile', 5, 'greeting', 'text', false), ('exec_voice_profile', 6, 'paragraphing', 'text', false),
      ('exec_voice_profile', 7, 'bullets', 'text', false), ('exec_voice_profile', 8, 'emoji', 'text', false),
      ('exec_voice_profile', 9, 'sign_off', 'text', false), ('exec_voice_profile', 10, 'sample_count', 'integer', true),
      ('exec_voice_profile', 11, 'samples_hash', 'text', false), ('exec_voice_profile', 12, 'window_days', 'integer', true),
      ('exec_voice_profile', 13, 'model', 'text', false), ('exec_voice_profile', 14, 'prompt_version', 'text', true),
      ('exec_voice_profile', 15, 'built_at', 'timestamp with time zone', true),
      ('exec_voice_profile', 16, 'last_attempt_at', 'timestamp with time zone', false),
      ('exec_voice_profile', 17, 'last_attempt_error', 'text', false),
      ('exec_voice_profile', 18, 'updated_at', 'timestamp with time zone', true)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select 'checks: ' || e.tbl, x.missing is null, x.missing
  from (values ('exec_drafts'), ('exec_voice_profile')) e(tbl)
  cross join lateral (
    select string_agg(k.name || case when k.needs is null then '' else ' (definition)' end, ', ' order by k.name) as missing
    from (values
      ('exec_drafts_kind_shape', null), ('exec_drafts_recipient_count', null), ('exec_drafts_versions', null),
      ('exec_drafts_prior', array['discarding', 'unknown']), ('exec_drafts_linked', null), ('exec_drafts_terminal', null),
      ('exec_drafts_expiry', null), ('exec_drafts_content_purged', null), ('exec_drafts_content_purged_when', null),
      ('exec_drafts_review_pair', null), ('exec_drafts_save_attempt', null), ('exec_drafts_send_attempt', null),
      ('exec_drafts_discard_attempt', null), ('exec_drafts_gone', null), ('exec_drafts_resolution', null),
      ('exec_drafts_id_check', null), ('exec_drafts_account_id_check', null), ('exec_drafts_kind_check', null),
      ('exec_drafts_origin_check', null), ('exec_drafts_status_check', null), ('exec_drafts_prior_status_check', null),
      ('exec_drafts_version_check', null), ('exec_drafts_saved_version_check', null), ('exec_drafts_generation_seq_check', null),
      ('exec_drafts_thread_id_check', null), ('exec_drafts_parent_message_id_check', null), ('exec_drafts_reply_mode_check', null),
      ('exec_drafts_thread_subject_check', null), ('exec_drafts_reply_candidates_check', null),
      ('exec_drafts_thread_addresses_check', null), ('exec_drafts_to_recipients_check', null),
      ('exec_drafts_cc_recipients_check', null), ('exec_drafts_bcc_recipients_check', null), ('exec_drafts_subject_check', null),
      ('exec_drafts_body_doc_check', null), ('exec_drafts_body_html_check', null), ('exec_drafts_body_text_check', null),
      ('exec_drafts_instruction_check', null), ('exec_drafts_note_for_mitchell_check', null),
      ('exec_drafts_placeholders_check', null), ('exec_drafts_review_recipients_check', null),
      ('exec_drafts_recipients_sig_check', null), ('exec_drafts_screen_hashes_check', null),
      ('exec_drafts_screened_policy_hash_check', null), ('exec_drafts_render_nonce_check', null), ('exec_drafts_model_check', null),
      ('exec_drafts_usage_check', null), ('exec_drafts_generation_error_check', null),
      ('exec_drafts_generation_flags_check', null),
      ('exec_drafts_facts_status_check', array['recipients_outside_client']), ('exec_drafts_client_id_check', null),
      ('exec_drafts_outlook_graph_id_check', null), ('exec_drafts_internet_message_id_check', null),
      ('exec_drafts_conversation_id_check', null), ('exec_drafts_web_link_check', null), ('exec_drafts_content_hash_check', null),
      ('exec_drafts_observed_content_hash_check', null), ('exec_drafts_review_hash_check', null),
      ('exec_drafts_review_blockers_check', array['facts_outside_client', 'unexpected_content']),
      ('exec_drafts_confirm_hash_check', null), ('exec_drafts_save_attempt_key_check', null),
      ('exec_drafts_save_version_check', null), ('exec_drafts_save_timezone_check', null),
      ('exec_drafts_save_if_content_hash_check', null), ('exec_drafts_discard_attempt_key_check', null),
      ('exec_drafts_send_attempt_key_check', null), ('exec_drafts_clone_flags_check', null),
      ('exec_drafts_owner_resolution_check', null), ('exec_drafts_last_error_code_check', null),
      ('exec_drafts_check_count_check', null),
      ('exec_voice_profile_ready', null), ('exec_voice_profile_status_check', null), ('exec_voice_profile_formality_check', null),
      ('exec_voice_profile_typical_length_check', null), ('exec_voice_profile_greeting_check', null),
      ('exec_voice_profile_paragraphing_check', null), ('exec_voice_profile_bullets_check', null),
      ('exec_voice_profile_emoji_check', null), ('exec_voice_profile_sign_off_check', null),
      ('exec_voice_profile_sample_count_check', null), ('exec_voice_profile_samples_hash_check', null),
      ('exec_voice_profile_window_days_check', null), ('exec_voice_profile_model_check', null),
      ('exec_voice_profile_prompt_version_check', null), ('exec_voice_profile_last_attempt_error_check', null)
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
  select 'content purge whitelist names every content column: exec_drafts', x.missing is null, x.missing
  from (
    select string_agg(col, ', ' order by col) as missing
    from unnest(array[
      'thread_subject', 'reply_candidates', 'thread_addresses', 'to_recipients', 'cc_recipients', 'bcc_recipients',
      'subject', 'body_doc', 'body_html', 'body_text', 'instruction', 'note_for_mitchell', 'placeholders', 'review_recipients'
    ]) col
    where not coalesce((
      select pg_get_constraintdef(pc.oid) ~ ('\m' || col || '\M')
      from pg_constraint pc
      where pc.conrelid = to_regclass('public.exec_drafts') and pc.conname = 'exec_drafts_content_purged'
    ), false)
  ) x
  union all
  select 'one active draft per thread', coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (select 1) one
  left join lateral (
    select i.indisunique and c.cols = array['principal_id', 'thread_id'] and c.pred is not null
             and c.pred ~ '\mgone_unconfirmed\M' and c.pred ~ '\mgenerating\M' and c.pred ~ '\mdiscarding\M' as ok,
           'unique=' || i.indisunique::text || ' columns=(' || array_to_string(c.cols, ', ') || ') where=' || coalesce(c.pred, '(none)') as found
    from pg_index i join pg_class ic on ic.oid = i.indexrelid
    cross join lateral (
      select array(select a.attname::text from unnest(i.indkey::int2[]) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum
                   order by u.ord) as cols,
             pg_get_expr(i.indpred, i.indrelid) as pred) c
    where i.indrelid = to_regclass('public.exec_drafts') and ic.relname = 'exec_drafts_one_active_per_thread'
  ) x on true
  union all
  select 'index: ' || e.name, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values
    ('exec_drafts_list_idx', array['principal_id', 'status', 'updated_at'], false),
    ('exec_drafts_thread_idx', array['principal_id', 'thread_id'], true),
    ('exec_drafts_due_idx', array['principal_id', 'next_check_at'], true),
    ('exec_drafts_content_purge_idx', array['terminal_at'], true),
    ('exec_drafts_expires_idx', array['expires_at'], true),
    ('exec_drafts_imid_idx', array['principal_id', 'internet_message_id'], true),
    ('exec_drafts_sent_audit_idx', array['sent_audit_id'], true)
  ) e(name, cols, partial)
  left join lateral (
    select c.cols = e.cols and (i.indpred is not null) = e.partial and not i.indisunique as ok,
           'columns=(' || array_to_string(c.cols, ', ') || ')' || case when i.indpred is not null then ' partial' else '' end
             || case when i.indisunique then ' unique' else '' end as found
    from pg_index i join pg_class ic on ic.oid = i.indexrelid
    cross join lateral (
      select array(select a.attname::text from unnest(i.indkey::int2[]) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum
                   order by u.ord) as cols) c
    where i.indrelid = to_regclass('public.exec_drafts') and ic.relname = e.name
  ) x on true
  union all
  select 'principal FK, on delete cascade: ' || e.tbl,
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'f'
                   and k.confrelid = 'public.exec_principals'::regclass and k.confdeltype = 'c'
                   and array(select a.attname::text from unnest(k.conkey) a0(attnum)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = a0.attnum) = array['principal_id']),
         null
  from (values ('exec_drafts'), ('exec_voice_profile')) e(tbl)
  union all
  select 'audit FK, on delete set null: exec_drafts.sent_audit_id',
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.exec_drafts') and k.contype = 'f'
                   and k.confrelid = 'public.exec_audit_log'::regclass and k.confdeltype = 'n'
                   and array(select a.attname::text from unnest(k.conkey) a0(attnum)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = a0.attnum) = array['sent_audit_id']),
         null
  union all
  select 'security invoker, pinned search_path: ' || e.fn, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values ('exec_drafts_purge_restricted(text,text[])'), ('exec_drafts_purge_expired(timestamp with time zone,integer)')) e(fn)
  left join lateral (
    select not p.prosecdef and coalesce(p.proconfig::text, '') like '%search_path=%' as ok,
           case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end
             || ', config ' || coalesce(p.proconfig::text, '(none)') as found
    from pg_proc p
    where p.oid = to_regprocedure('public.' || e.fn)
  ) x on true
) checks
order by ok, check_name;
