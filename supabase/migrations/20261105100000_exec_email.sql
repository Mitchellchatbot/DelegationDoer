-- Executive AI Assistant — P3 email intelligence.
--
--   exec_settings.email_enabled  the switch (default false). The app runs no
--                                email work until it is true AND a mailbox
--                                is pinned (exec_principals.mail_account_ids).
--   exec_email_threads           one row per (principal, clone thread) of his
--                                mail: clone-derived facts, the triage
--                                outcome, and one-way screening hashes. A
--                                thread whose mail touches a restricted
--                                sender is a TOMBSTONE (state
--                                'restricted_hidden'): the whitelist CHECK
--                                below leaves nothing about the mail on it.
--   exec_commitments             promises found in his mail, each with a
--                                short verbatim evidence quote.
--   exec_email_signals           Outlook signals per message of his (flag,
--                                importance, unread, archived/deleted, the
--                                web link), from the clone's CL1 feed.
--
-- What may be stored (contract §0): ids, times, counts, codes and these
-- clipped exceptions, kept only for retention_days_email: the subject
-- (<=200, from his newest message), the AI summary (<=400), reason (<=160)
-- and decision question (<=200), display addresses of his own messages, a
-- commitment's text (<=200) and verified evidence excerpt (<=280). Never a
-- message body. A tombstone holds none of it.
--
-- RPCs (SECURITY INVOKER, search_path pinned to '', EXECUTE for service_role
-- only, like the P2a job RPCs):
--   exec_email_stamp_screened      bulk "screened under policy H" stamp, CAS
--                                  on each row's version.
--   exec_email_upsert_signals      monotonic upsert of feed signals; skips
--                                  tombstoned threads.
--   exec_email_insert_commitments  insert-if-new per message, serialized per
--                                  thread, never onto a tombstone or a gone
--                                  thread; extends the thread's expiry.
--
-- Security: RLS ON with NO policies and nothing granted to anon/authenticated,
-- like every exec_ table. The app reaches them only through the service role.
--
-- Nothing reads these tables until EXEC_ENABLED=true and email_enabled=true,
-- and the app tolerates this file being applied late (email stays off), so
-- applying it early is harmless.
--
-- Idempotent. Apply MANUALLY in the Supabase SQL editor, AFTER
-- 20261104100000_exec_foundation.sql and 20261104200000_exec_attention.sql.
-- Merging runs nothing. Turning email on is two hand-run scripts afterwards
-- (supabase/scripts/20261105_exec_p3_pin_mail_account.sql, then
-- 20261105_exec_p3_enable_email.sql).

set local lock_timeout = '5s';

-- Pre-flight: P2a and P2b must be applied first. Aborts before changing anything.
do $$
begin
  if to_regclass('public.exec_principals') is null or to_regclass('public.exec_settings') is null then
    raise exception 'exec email aborted, nothing changed: the P2a foundation is missing (apply 20261104100000_exec_foundation.sql first)';
  end if;
  if to_regclass('public.exec_attention_items') is null then
    raise exception 'exec email aborted, nothing changed: public.exec_attention_items does not exist (apply 20261104200000_exec_attention.sql first)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

alter table public.exec_settings add column if not exists email_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Threads
-- ---------------------------------------------------------------------------

create table if not exists public.exec_email_threads (
  principal_id      text not null references public.exec_principals(id) on delete cascade,
  thread_id         text not null
                      constraint exec_email_threads_thread_id_check check (char_length(thread_id) between 1 and 200),
  account_id        text not null
                      constraint exec_email_threads_account_id_check check (char_length(account_id) between 1 and 200),
  -- No 'pending': every row is written with an outcome (contract v3.1 A3).
  state             text not null
                      constraint exec_email_threads_state_check
                      check (state in ('triaged', 'filtered', 'triage_failed', 'deferred_budget', 'restricted_hidden', 'gone')),
  -- Bumped by every write; writers compare-and-set on it.
  version           integer not null default 1
                      constraint exec_email_threads_version_check check (version >= 1),

  -- The clone read behind the stored facts (allowed on tombstones). Reads are
  -- ordered by happens-before on read_started/read_done (A4); max_sent_at
  -- serves only list-mode reconcile's skip rule.
  snapshot_identity_count  integer not null default 0
                             constraint exec_email_threads_snapshot_identity_count_check check (snapshot_identity_count >= 0),
  snapshot_max_created_at  timestamptz,
  snapshot_max_sent_at     timestamptz,
  snapshot_read_started_at timestamptz,
  snapshot_read_done_at    timestamptz,
  -- The clone answered 404 for the thread (done time of that read).
  gone_at           timestamptz,

  -- Screening (allowed on tombstones): sha256 prefixes of every address and
  -- domain suffix the thread was ever seen with, never the addresses
  -- themselves. Only ever grows; past 600 the row is marked truncated for good.
  screen_hashes        text[] not null default '{}'
                         constraint exec_email_threads_screen_hashes_check
                         check (cardinality(screen_hashes) <= 600
                                and array_position(screen_hashes, null) is null
                                and array_to_string(screen_hashes, ',') ~ '^([0-9a-f]{32}(,[0-9a-f]{32})*)?$'),
  screen_truncated     boolean not null default false,
  screened_policy_hash text
                         constraint exec_email_threads_screened_policy_hash_check
                         check (screened_policy_hash is null or screened_policy_hash ~ '^[0-9a-f]{64}$'),

  -- Display (his messages only).
  subject           text constraint exec_email_threads_subject_check check (subject is null or char_length(subject) <= 200),
  counterpart_name  text constraint exec_email_threads_counterpart_name_check check (counterpart_name is null or char_length(counterpart_name) <= 120),
  counterpart_email text constraint exec_email_threads_counterpart_email_check check (counterpart_email is null or char_length(counterpart_email) <= 320),
  correspondents    text[] not null default '{}'
                      constraint exec_email_threads_correspondents_check check (cardinality(correspondents) <= 50),
  message_count     integer not null default 0
                      constraint exec_email_threads_message_count_check check (message_count >= 0),
  newest_message_id          text,
  newest_inbound_message_id  text,
  newest_outbound_message_id text,

  -- Deterministic facts.
  last_inbound_at      timestamptz,
  last_outbound_at     timestamptz,
  newest_is_outbound   boolean,
  answered_state       text
                         constraint exec_email_threads_answered_state_check
                         check (answered_state is null or answered_state in ('awaiting_reply', 'answered', 'no_inbound')),
  answered_at          timestamptz,
  answered_message_id  text,
  partial_thread          boolean not null default false,
  outbound_automated_only boolean not null default false,
  client_id            text,
  client_name          text constraint exec_email_threads_client_name_check check (client_name is null or char_length(client_name) <= 200),
  client_match_via     text
                         constraint exec_email_threads_client_match_via_check
                         check (client_match_via is null or client_match_via in ('exact', 'domain')),
  match_confidence     text
                         constraint exec_email_threads_match_confidence_check
                         check (match_confidence is null or match_confidence in ('high', 'medium', 'low')),
  client_candidates    integer not null default 0
                         constraint exec_email_threads_client_candidates_check check (client_candidates >= 0),

  -- AI fields (set by a triaged outcome; kept through later failures).
  summary           text constraint exec_email_threads_summary_check check (summary is null or char_length(summary) <= 400),
  reason            text constraint exec_email_threads_reason_check check (reason is null or char_length(reason) <= 160),
  category          text
                      constraint exec_email_threads_category_check
                      check (category is null or category in ('client', 'prospect', 'partner_vendor', 'internal_team', 'finance_admin', 'legal',
                                                              'recruiting', 'personal', 'newsletter_marketing', 'notification', 'calendar', 'other')),
  urgency           text
                      constraint exec_email_threads_urgency_check check (urgency is null or urgency in ('critical', 'high', 'normal', 'low')),
  importance        text
                      constraint exec_email_threads_importance_check check (importance is null or importance in ('high', 'normal', 'low')),
  needs_reply                boolean,
  mitchell_personally        boolean,
  awaiting_reply_from_others boolean,
  decision_question text
                      constraint exec_email_threads_decision_question_check
                      check (decision_question is null or char_length(decision_question) <= 200),
  decision_message_id text,
  client_signal     text
                      constraint exec_email_threads_client_signal_check
                      check (client_signal is null or client_signal in ('none', 'complaint', 'churn_risk', 'outage_or_breakage',
                                                                        'billing_or_legal_dispute', 'praise')),
  automated           boolean,
  injection_suspected boolean not null default false,

  -- Run metadata.
  filter_reason     text
                      constraint exec_email_threads_filter_reason_check
                      check (filter_reason is null or filter_reason in ('unreplyable', 'automated_hint')),
  triage_error      text
                      constraint exec_email_threads_triage_error_check
                      check (triage_error is null or triage_error in ('refusal', 'truncated', 'invalid_output', 'input_too_large')),
  refusal_category  text
                      constraint exec_email_threads_refusal_category_check
                      check (refusal_category is null or char_length(refusal_category) <= 60),
  content_hash      text
                      constraint exec_email_threads_content_hash_check check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  model             text,
  triage_version    text,
  attempted_version text,
  -- "Extracted through": moved only by a triaged write (A5).
  input_watermark   timestamptz,
  -- Moved by every written outcome; the outcome guard compares against it (A5).
  outcome_watermark timestamptz,
  input_truncated   boolean not null default false,
  body_source       text
                      constraint exec_email_threads_body_source_check
                      check (body_source is null or body_source in ('html', 'text', 'preview_stub', 'mixed', 'empty')),
  triaged_at        timestamptz,
  deferred_at       timestamptz,
  last_attempt_at   timestamptz,
  last_attempt_error text
                      constraint exec_email_threads_last_attempt_error_check
                      check (last_attempt_error is null or last_attempt_error in ('refusal', 'truncated', 'invalid_output', 'input_too_large', 'budget')),

  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Newest activity + retention_days_email, computed by the app (never now()).
  expires_at        timestamptz not null,

  constraint exec_email_threads_pkey primary key (principal_id, thread_id),
  -- A gone row, and only a gone row, says when the clone lost the thread.
  constraint exec_email_threads_gone_check check ((state = 'gone') = (gone_at is not null)),
  -- A tombstone keeps nothing about the mail: only its key, account, state,
  -- version, snapshot, screening hashes and stamp, and its own timestamps.
  constraint exec_email_threads_tombstone_whitelist check (state <> 'restricted_hidden' or (
    gone_at is null
    and subject is null and counterpart_name is null and counterpart_email is null
    and cardinality(correspondents) = 0 and message_count = 0
    and newest_message_id is null and newest_inbound_message_id is null and newest_outbound_message_id is null
    and last_inbound_at is null and last_outbound_at is null and newest_is_outbound is null
    and answered_state is null and answered_at is null and answered_message_id is null
    and partial_thread = false and outbound_automated_only = false
    and client_id is null and client_name is null and client_match_via is null and match_confidence is null and client_candidates = 0
    and summary is null and reason is null and category is null and urgency is null and importance is null
    and needs_reply is null and mitchell_personally is null and awaiting_reply_from_others is null
    and decision_question is null and decision_message_id is null and client_signal is null and automated is null
    and injection_suspected = false and filter_reason is null and triage_error is null and refusal_category is null
    and content_hash is null and model is null and triage_version is null and attempted_version is null
    and input_watermark is null and outcome_watermark is null and input_truncated = false and body_source is null
    and triaged_at is null and deferred_at is null and last_attempt_at is null and last_attempt_error is null))
);

-- Bucket reads: one principal's rows by state and recency.
create index if not exists exec_email_threads_state_idx on public.exec_email_threads (principal_id, state, last_inbound_at desc);
-- The attention pass finds rows screened under another policy.
create index if not exists exec_email_threads_screen_idx on public.exec_email_threads (principal_id, screened_policy_hash);
-- The daily purge deletes by expiry across all principals.
create index if not exists exec_email_threads_expires_idx on public.exec_email_threads (expires_at);

-- ---------------------------------------------------------------------------
-- Commitments
-- ---------------------------------------------------------------------------

create table if not exists public.exec_commitments (
  id               text primary key default ('ec_' || replace(gen_random_uuid()::text, '-', '')),
  principal_id     text not null references public.exec_principals(id) on delete cascade,
  -- sha256 of direction + message id + normalized evidence (one row per promise).
  fingerprint      text not null
                     constraint exec_commitments_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$'),
  source           text not null default 'email'
                     constraint exec_commitments_source_check check (source in ('email', 'slack')),
  thread_id        text not null
                     constraint exec_commitments_thread_id_check check (char_length(thread_id) between 1 and 200),
  message_id       text not null
                     constraint exec_commitments_message_id_check check (char_length(message_id) between 1 and 200),
  account_id       text not null
                     constraint exec_commitments_account_id_check check (char_length(account_id) between 1 and 200),
  direction        text not null
                     constraint exec_commitments_direction_check check (direction in ('mitchell_owes', 'owed_to_mitchell')),
  text             text not null
                     constraint exec_commitments_text_check check (char_length(text) between 1 and 200),
  counterparty     text
                     constraint exec_commitments_counterparty_check check (counterparty is null or char_length(counterparty) <= 120),
  due_at           timestamptz,
  due_text         text
                     constraint exec_commitments_due_text_check check (due_text is null or char_length(due_text) <= 60),
  status           text not null default 'open'
                     constraint exec_commitments_status_check check (status in ('open', 'followed_up', 'expired')),
  followed_up_at   timestamptz,
  -- A verified verbatim quote; never copied into attention items or refs.
  evidence_excerpt text not null
                     constraint exec_commitments_evidence_excerpt_check check (char_length(evidence_excerpt) between 1 and 280),
  -- A SourceRef object. The evidence quote must not ride along in it.
  source_ref       jsonb not null
                     constraint exec_commitments_source_ref_check check (jsonb_typeof(source_ref) = 'object' and not (source_ref ? 'excerpt')),
  message_sent_at    timestamptz not null,
  message_created_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- greatest(message_sent_at, due_at) + retention_days_email, computed by the app.
  expires_at       timestamptz not null,
  constraint exec_commitments_fingerprint_key unique (principal_id, fingerprint),
  -- A followed-up commitment says when, and only a followed-up one does.
  constraint exec_commitments_followed_up_check check ((status = 'followed_up') = (followed_up_at is not null))
);

create index if not exists exec_commitments_thread_idx  on public.exec_commitments (principal_id, thread_id);
create index if not exists exec_commitments_due_idx     on public.exec_commitments (principal_id, status, due_at);
create index if not exists exec_commitments_expires_idx on public.exec_commitments (expires_at);

-- ---------------------------------------------------------------------------
-- Outlook signals (CL1 feed), one row per message of his
-- ---------------------------------------------------------------------------

create table if not exists public.exec_email_signals (
  principal_id text not null references public.exec_principals(id) on delete cascade,
  message_id   text not null
                 constraint exec_email_signals_message_id_check check (char_length(message_id) between 1 and 200),
  thread_id    text not null
                 constraint exec_email_signals_thread_id_check check (char_length(thread_id) between 1 and 200),
  account_id   text not null
                 constraint exec_email_signals_account_id_check check (char_length(account_id) between 1 and 200),
  direction    text not null
                 constraint exec_email_signals_direction_check check (direction in ('inbound', 'outbound')),
  flagged      boolean,
  importance   text
                 constraint exec_email_signals_importance_check check (importance is null or importance in ('low', 'normal', 'high')),
  unread       boolean,
  -- Left his folders (archived or deleted in Outlook).
  removed_at   timestamptz,
  -- The Outlook web link, https only (it is rendered as a link).
  web_link     text
                 constraint exec_email_signals_web_link_check
                 check (web_link is null or (char_length(web_link) <= 2048 and web_link ~ '^https://')),
  -- COALESCE(signals_updated_at, created_at) of the feed row; upserts only move it forward.
  signals_at   timestamptz not null,
  -- signals_at + retention_days_email.
  expires_at   timestamptz not null,
  constraint exec_email_signals_pkey primary key (principal_id, message_id)
);

create index if not exists exec_email_signals_thread_idx  on public.exec_email_signals (principal_id, thread_id);
create index if not exists exec_email_signals_expires_idx on public.exec_email_signals (expires_at);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Stamp rows as screened under policy p_hash, in one round trip per chunk.
-- p_items: [{ "thread_id": text, "version": int }]. A row is stamped only
-- while its version is still the one the caller planned from (CAS); a row
-- written since is left alone and the caller re-plans it next pass. Returns
-- how many rows were stamped.
create or replace function public.exec_email_stamp_screened(p_principal text, p_items jsonb, p_hash text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'exec_email_stamp_screened: p_hash must be a sha256 hex digest';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'exec_email_stamp_screened: p_items must be a JSON array';
  end if;

  with items as (
    select x->>'thread_id' as thread_id, (x->>'version')::int as version
      from jsonb_array_elements(p_items) x
  ), u as (
    update public.exec_email_threads t
       set screened_policy_hash = p_hash, version = t.version + 1, updated_at = now()
      from items i
     where t.principal_id = p_principal and t.thread_id = i.thread_id and t.version = i.version
    returning 1
  )
  select count(*)::int into n from u;
  return n;
end;
$$;

-- Upsert one feed page's signals. Monotonic: a row is replaced only by a
-- strictly newer signals_at, so a page that arrives late can't undo a newer
-- state. One row per message (a page may repeat one: the newest wins), and a
-- malformed row is dropped (or its bad optional field nulled) instead of
-- failing the page, so one odd row can't wedge the feed cursor. Rows of a
-- thread that is a tombstone are skipped: a restricted thread keeps no web
-- link or signal (the tombstone procedure deleted its rows). expires_at is
-- signals_at plus the principal's retention_days_email. Returns how many rows
-- were inserted or replaced.
-- p_rows: [{ message_id, thread_id, account_id, direction, flagged, importance,
--            unread, removed_at, web_link, signals_at }]
create or replace function public.exec_email_upsert_signals(p_principal text, p_rows jsonb)
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
    raise exception 'exec_email_upsert_signals: p_principal is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'exec_email_upsert_signals: p_rows must be a JSON array';
  end if;
  select coalesce(max(s.retention_days_email), 180) into v_days
    from public.exec_settings s where s.principal_id = p_principal;

  with incoming as (
    select r.*
      from jsonb_to_recordset(p_rows) as r(message_id text, thread_id text, account_id text, direction text, flagged boolean,
                                           importance text, unread boolean, removed_at timestamptz, web_link text,
                                           signals_at timestamptz)
  ), clean as (
    select distinct on (c.message_id)
           c.message_id, c.thread_id, c.account_id, c.direction, c.flagged,
           case when c.importance in ('low', 'normal', 'high') then c.importance end as importance,
           c.unread, c.removed_at,
           case when c.web_link ~ '^https://' and char_length(c.web_link) <= 2048 then c.web_link end as web_link,
           c.signals_at
      from incoming c
     where char_length(c.message_id) between 1 and 200
       and char_length(c.thread_id) between 1 and 200
       and char_length(c.account_id) between 1 and 200
       and c.direction in ('inbound', 'outbound')
       and c.signals_at is not null
     order by c.message_id, c.signals_at desc
  ), w as (
    insert into public.exec_email_signals as s
           (principal_id, message_id, thread_id, account_id, direction, flagged, importance, unread, removed_at, web_link,
            signals_at, expires_at)
    select p_principal, c.message_id, c.thread_id, c.account_id, c.direction, c.flagged, c.importance, c.unread, c.removed_at,
           c.web_link, c.signals_at, c.signals_at + make_interval(days => v_days)
      from clean c
     where not exists (select 1 from public.exec_email_threads t
                        where t.principal_id = p_principal and t.thread_id = c.thread_id and t.state = 'restricted_hidden')
    on conflict (principal_id, message_id) do update
       set thread_id = excluded.thread_id, account_id = excluded.account_id, direction = excluded.direction,
           flagged = excluded.flagged, importance = excluded.importance, unread = excluded.unread,
           removed_at = excluded.removed_at, web_link = excluded.web_link,
           signals_at = excluded.signals_at, expires_at = excluded.expires_at
     where excluded.signals_at > s.signals_at
    returning 1
  )
  select count(*)::int into n from w;
  return n;
end;
$$;

-- Insert the commitments one triaged write extracted from one thread, and
-- return the rows actually inserted (a JSON array). Serialized per
-- (principal, thread) by an advisory transaction lock, so two overlapping
-- triage jobs that both extracted the same message can't both store it: a
-- row is inserted only when its message has no commitment on the thread yet
-- (any status), and the fingerprint unique drops exact repeats. Nothing is
-- inserted onto a thread row that is missing, a tombstone or gone; the row is
-- locked (FOR UPDATE) first, which orders this against a concurrent tombstone
-- write. The thread's expires_at is raised to the latest inserted
-- commitment's, so a long-dated promise keeps its thread (and stays
-- screenable) until it expires.
-- p_rows: [{ fingerprint, source, thread_id, message_id, account_id, direction,
--            text, counterparty, due_at, due_text, status, followed_up_at,
--            evidence_excerpt, source_ref, message_sent_at, message_created_at,
--            expires_at }]
create or replace function public.exec_email_insert_commitments(p_principal text, p_thread_id text, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_state text;
  v_out jsonb;
begin
  if p_principal is null or p_thread_id is null then
    raise exception 'exec_email_insert_commitments: p_principal and p_thread_id are required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'exec_email_insert_commitments: p_rows must be a JSON array';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where e->>'thread_id' is distinct from p_thread_id) then
    raise exception 'exec_email_insert_commitments: every row must belong to p_thread_id';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_principal || ':' || p_thread_id));

  select t.state into v_state
    from public.exec_email_threads t
   where t.principal_id = p_principal and t.thread_id = p_thread_id
   for update;
  if v_state is null or v_state in ('restricted_hidden', 'gone') then
    return '[]'::jsonb;
  end if;

  with incoming as (
    select r.*
      from jsonb_to_recordset(p_rows) as r(fingerprint text, source text, thread_id text, message_id text, account_id text,
                                           direction text, text text, counterparty text, due_at timestamptz, due_text text,
                                           status text, followed_up_at timestamptz, evidence_excerpt text, source_ref jsonb,
                                           message_sent_at timestamptz, message_created_at timestamptz, expires_at timestamptz)
  ), fresh as (
    select i.*
      from incoming i
     where not exists (select 1 from public.exec_commitments c
                        where c.principal_id = p_principal and c.thread_id = p_thread_id and c.message_id = i.message_id)
  ), ins as (
    insert into public.exec_commitments
           (principal_id, fingerprint, source, thread_id, message_id, account_id, direction, text, counterparty, due_at, due_text,
            status, followed_up_at, evidence_excerpt, source_ref, message_sent_at, message_created_at, expires_at)
    select p_principal, f.fingerprint, f.source, f.thread_id, f.message_id, f.account_id, f.direction, f.text, f.counterparty,
           f.due_at, f.due_text, f.status, f.followed_up_at, f.evidence_excerpt, f.source_ref, f.message_sent_at,
           f.message_created_at, f.expires_at
      from fresh f
    on conflict (principal_id, fingerprint) do nothing
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(ins) order by ins.id), '[]'::jsonb) into v_out from ins;

  update public.exec_email_threads t
     set expires_at = greatest(t.expires_at, x.max_expires)
    from (select max((e->>'expires_at')::timestamptz) as max_expires from jsonb_array_elements(v_out) e) x
   where t.principal_id = p_principal and t.thread_id = p_thread_id and x.max_expires is not null;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, no policies; service_role only
-- ---------------------------------------------------------------------------

alter table public.exec_email_threads enable row level security;
alter table public.exec_commitments   enable row level security;
alter table public.exec_email_signals enable row level security;

revoke all on public.exec_email_threads, public.exec_commitments, public.exec_email_signals from public, anon, authenticated;
grant all on public.exec_email_threads, public.exec_commitments, public.exec_email_signals to service_role;

revoke all on function public.exec_email_stamp_screened(text, jsonb, text) from public, anon, authenticated;
revoke all on function public.exec_email_upsert_signals(text, jsonb) from public, anon, authenticated;
revoke all on function public.exec_email_insert_commitments(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.exec_email_stamp_screened(text, jsonb, text) to service_role;
grant execute on function public.exec_email_upsert_signals(text, jsonb) to service_role;
grant execute on function public.exec_email_insert_commitments(text, text, jsonb) to service_role;

-- So PostgREST sees the new tables, column and functions without waiting for a restart.
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
--   * exec_settings.email_enabled: boolean, not null, default false;
--   * every column of the three tables, with its type and nullability;
--   * every named CHECK, and a tombstone whitelist that names every content
--     column; the primary keys and the commitments' unique fingerprint; the
--     principal FKs with ON DELETE CASCADE;
--   * the eight indexes, compared by definition;
--   * the three RPCs: SECURITY INVOKER with a pinned search_path.
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
  select 'column: exec_settings.email_enabled boolean not null default false',
         coalesce(x.ok, false), case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (select 1) one
  left join lateral (
    select format_type(a.atttypid, a.atttypmod) = 'boolean' and a.attnotnull
             and pg_get_expr(d.adbin, d.adrelid) = 'false' as ok,
           format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
             || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ' (no default)') as found
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.exec_settings'::regclass and a.attname = 'email_enabled' and not a.attisdropped
  ) x on true
  union all
  select 'columns: ' || e.tbl, x.wrong is null, x.wrong
  from (values ('exec_email_threads'), ('exec_commitments'), ('exec_email_signals')) e(tbl)
  cross join lateral (
    select string_agg(c.col || ' ' || c.typ || case when c.required then ' not null' else '' end, ', ' order by c.ord) as wrong
    from (values
      ('exec_email_threads', 1, 'principal_id', 'text', true), ('exec_email_threads', 2, 'thread_id', 'text', true),
      ('exec_email_threads', 3, 'account_id', 'text', true), ('exec_email_threads', 4, 'state', 'text', true),
      ('exec_email_threads', 5, 'version', 'integer', true), ('exec_email_threads', 6, 'snapshot_identity_count', 'integer', true),
      ('exec_email_threads', 7, 'snapshot_max_created_at', 'timestamp with time zone', false),
      ('exec_email_threads', 8, 'snapshot_max_sent_at', 'timestamp with time zone', false),
      ('exec_email_threads', 9, 'snapshot_read_started_at', 'timestamp with time zone', false),
      ('exec_email_threads', 10, 'snapshot_read_done_at', 'timestamp with time zone', false),
      ('exec_email_threads', 11, 'gone_at', 'timestamp with time zone', false),
      ('exec_email_threads', 12, 'screen_hashes', 'text[]', true), ('exec_email_threads', 13, 'screen_truncated', 'boolean', true),
      ('exec_email_threads', 14, 'screened_policy_hash', 'text', false), ('exec_email_threads', 15, 'subject', 'text', false),
      ('exec_email_threads', 16, 'counterpart_name', 'text', false), ('exec_email_threads', 17, 'counterpart_email', 'text', false),
      ('exec_email_threads', 18, 'correspondents', 'text[]', true), ('exec_email_threads', 19, 'message_count', 'integer', true),
      ('exec_email_threads', 20, 'newest_message_id', 'text', false), ('exec_email_threads', 21, 'newest_inbound_message_id', 'text', false),
      ('exec_email_threads', 22, 'newest_outbound_message_id', 'text', false),
      ('exec_email_threads', 23, 'last_inbound_at', 'timestamp with time zone', false),
      ('exec_email_threads', 24, 'last_outbound_at', 'timestamp with time zone', false),
      ('exec_email_threads', 25, 'newest_is_outbound', 'boolean', false), ('exec_email_threads', 26, 'answered_state', 'text', false),
      ('exec_email_threads', 27, 'answered_at', 'timestamp with time zone', false),
      ('exec_email_threads', 28, 'answered_message_id', 'text', false), ('exec_email_threads', 29, 'partial_thread', 'boolean', true),
      ('exec_email_threads', 30, 'outbound_automated_only', 'boolean', true), ('exec_email_threads', 31, 'client_id', 'text', false),
      ('exec_email_threads', 32, 'client_name', 'text', false), ('exec_email_threads', 33, 'client_match_via', 'text', false),
      ('exec_email_threads', 34, 'match_confidence', 'text', false), ('exec_email_threads', 35, 'client_candidates', 'integer', true),
      ('exec_email_threads', 36, 'summary', 'text', false), ('exec_email_threads', 37, 'reason', 'text', false),
      ('exec_email_threads', 38, 'category', 'text', false), ('exec_email_threads', 39, 'urgency', 'text', false),
      ('exec_email_threads', 40, 'importance', 'text', false), ('exec_email_threads', 41, 'needs_reply', 'boolean', false),
      ('exec_email_threads', 42, 'mitchell_personally', 'boolean', false),
      ('exec_email_threads', 43, 'awaiting_reply_from_others', 'boolean', false),
      ('exec_email_threads', 44, 'decision_question', 'text', false), ('exec_email_threads', 45, 'decision_message_id', 'text', false),
      ('exec_email_threads', 46, 'client_signal', 'text', false), ('exec_email_threads', 47, 'automated', 'boolean', false),
      ('exec_email_threads', 48, 'injection_suspected', 'boolean', true), ('exec_email_threads', 49, 'filter_reason', 'text', false),
      ('exec_email_threads', 50, 'triage_error', 'text', false), ('exec_email_threads', 51, 'refusal_category', 'text', false),
      ('exec_email_threads', 52, 'content_hash', 'text', false), ('exec_email_threads', 53, 'model', 'text', false),
      ('exec_email_threads', 54, 'triage_version', 'text', false), ('exec_email_threads', 55, 'attempted_version', 'text', false),
      ('exec_email_threads', 56, 'input_watermark', 'timestamp with time zone', false),
      ('exec_email_threads', 57, 'outcome_watermark', 'timestamp with time zone', false),
      ('exec_email_threads', 58, 'input_truncated', 'boolean', true), ('exec_email_threads', 59, 'body_source', 'text', false),
      ('exec_email_threads', 60, 'triaged_at', 'timestamp with time zone', false),
      ('exec_email_threads', 61, 'deferred_at', 'timestamp with time zone', false),
      ('exec_email_threads', 62, 'last_attempt_at', 'timestamp with time zone', false),
      ('exec_email_threads', 63, 'last_attempt_error', 'text', false),
      ('exec_email_threads', 64, 'first_seen_at', 'timestamp with time zone', true),
      ('exec_email_threads', 65, 'updated_at', 'timestamp with time zone', true),
      ('exec_email_threads', 66, 'expires_at', 'timestamp with time zone', true),
      ('exec_commitments', 1, 'id', 'text', true), ('exec_commitments', 2, 'principal_id', 'text', true),
      ('exec_commitments', 3, 'fingerprint', 'text', true), ('exec_commitments', 4, 'source', 'text', true),
      ('exec_commitments', 5, 'thread_id', 'text', true), ('exec_commitments', 6, 'message_id', 'text', true),
      ('exec_commitments', 7, 'account_id', 'text', true), ('exec_commitments', 8, 'direction', 'text', true),
      ('exec_commitments', 9, 'text', 'text', true), ('exec_commitments', 10, 'counterparty', 'text', false),
      ('exec_commitments', 11, 'due_at', 'timestamp with time zone', false), ('exec_commitments', 12, 'due_text', 'text', false),
      ('exec_commitments', 13, 'status', 'text', true), ('exec_commitments', 14, 'followed_up_at', 'timestamp with time zone', false),
      ('exec_commitments', 15, 'evidence_excerpt', 'text', true), ('exec_commitments', 16, 'source_ref', 'jsonb', true),
      ('exec_commitments', 17, 'message_sent_at', 'timestamp with time zone', true),
      ('exec_commitments', 18, 'message_created_at', 'timestamp with time zone', false),
      ('exec_commitments', 19, 'created_at', 'timestamp with time zone', true),
      ('exec_commitments', 20, 'updated_at', 'timestamp with time zone', true),
      ('exec_commitments', 21, 'expires_at', 'timestamp with time zone', true),
      ('exec_email_signals', 1, 'principal_id', 'text', true), ('exec_email_signals', 2, 'message_id', 'text', true),
      ('exec_email_signals', 3, 'thread_id', 'text', true), ('exec_email_signals', 4, 'account_id', 'text', true),
      ('exec_email_signals', 5, 'direction', 'text', true), ('exec_email_signals', 6, 'flagged', 'boolean', false),
      ('exec_email_signals', 7, 'importance', 'text', false), ('exec_email_signals', 8, 'unread', 'boolean', false),
      ('exec_email_signals', 9, 'removed_at', 'timestamp with time zone', false), ('exec_email_signals', 10, 'web_link', 'text', false),
      ('exec_email_signals', 11, 'signals_at', 'timestamp with time zone', true),
      ('exec_email_signals', 12, 'expires_at', 'timestamp with time zone', true)
    ) c(tbl, ord, col, typ, required)
    where c.tbl = e.tbl
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || e.tbl) and a.attnum > 0 and not a.attisdropped
          and a.attname = c.col and format_type(a.atttypid, a.atttypmod) = c.typ and a.attnotnull = c.required)
  ) x
  union all
  select 'checks: ' || e.tbl, x.missing is null, x.missing
  from (values ('exec_email_threads'), ('exec_commitments'), ('exec_email_signals')) e(tbl)
  cross join lateral (
    select string_agg(k.name, ', ' order by k.name) as missing
    from unnest(array[
      'exec_email_threads_thread_id_check', 'exec_email_threads_account_id_check', 'exec_email_threads_state_check',
      'exec_email_threads_version_check', 'exec_email_threads_snapshot_identity_count_check', 'exec_email_threads_screen_hashes_check',
      'exec_email_threads_screened_policy_hash_check', 'exec_email_threads_subject_check', 'exec_email_threads_counterpart_name_check',
      'exec_email_threads_counterpart_email_check', 'exec_email_threads_correspondents_check', 'exec_email_threads_message_count_check',
      'exec_email_threads_answered_state_check', 'exec_email_threads_client_name_check', 'exec_email_threads_client_match_via_check',
      'exec_email_threads_match_confidence_check', 'exec_email_threads_client_candidates_check', 'exec_email_threads_summary_check',
      'exec_email_threads_reason_check', 'exec_email_threads_category_check', 'exec_email_threads_urgency_check',
      'exec_email_threads_importance_check', 'exec_email_threads_decision_question_check', 'exec_email_threads_client_signal_check',
      'exec_email_threads_filter_reason_check', 'exec_email_threads_triage_error_check', 'exec_email_threads_refusal_category_check',
      'exec_email_threads_content_hash_check', 'exec_email_threads_body_source_check', 'exec_email_threads_last_attempt_error_check',
      'exec_email_threads_gone_check', 'exec_email_threads_tombstone_whitelist',
      'exec_commitments_fingerprint_check', 'exec_commitments_source_check', 'exec_commitments_thread_id_check',
      'exec_commitments_message_id_check', 'exec_commitments_account_id_check', 'exec_commitments_direction_check',
      'exec_commitments_text_check', 'exec_commitments_counterparty_check', 'exec_commitments_due_text_check',
      'exec_commitments_status_check', 'exec_commitments_evidence_excerpt_check', 'exec_commitments_source_ref_check',
      'exec_commitments_followed_up_check',
      'exec_email_signals_message_id_check', 'exec_email_signals_thread_id_check', 'exec_email_signals_account_id_check',
      'exec_email_signals_direction_check', 'exec_email_signals_importance_check', 'exec_email_signals_web_link_check'
    ]) k(name)
    where starts_with(k.name, e.tbl || '_')
      and not exists (select 1 from pg_constraint pc
                      where pc.conrelid = to_regclass('public.' || e.tbl) and pc.contype = 'c' and pc.conname = k.name)
  ) x
  union all
  select 'tombstone whitelist names every content column: exec_email_threads', x.missing is null, x.missing
  from (
    select string_agg(col, ', ' order by col) as missing
    from unnest(array[
      'gone_at', 'subject', 'counterpart_name', 'counterpart_email', 'correspondents', 'message_count', 'newest_message_id',
      'newest_inbound_message_id', 'newest_outbound_message_id', 'last_inbound_at', 'last_outbound_at', 'newest_is_outbound',
      'answered_state', 'answered_at', 'answered_message_id', 'partial_thread', 'outbound_automated_only', 'client_id',
      'client_name', 'client_match_via', 'match_confidence', 'client_candidates', 'summary', 'reason', 'category', 'urgency',
      'importance', 'needs_reply', 'mitchell_personally', 'awaiting_reply_from_others', 'decision_question',
      'decision_message_id', 'client_signal', 'automated', 'injection_suspected', 'filter_reason', 'triage_error',
      'refusal_category', 'content_hash', 'model', 'triage_version', 'attempted_version', 'input_watermark',
      'outcome_watermark', 'input_truncated', 'body_source', 'triaged_at', 'deferred_at', 'last_attempt_at', 'last_attempt_error'
    ]) col
    where not coalesce((
      select pg_get_constraintdef(pc.oid) ~ ('\m' || col || '\M')
      from pg_constraint pc
      where pc.conrelid = to_regclass('public.exec_email_threads') and pc.conname = 'exec_email_threads_tombstone_whitelist'
    ), false)
  ) x
  union all
  select 'primary key (' || e.cols || '): ' || e.tbl,
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'p'
                   and array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                             order by u.ord) = string_to_array(e.cols, ', ')),
         null
  from (values ('exec_email_threads', 'principal_id, thread_id'), ('exec_commitments', 'id'),
               ('exec_email_signals', 'principal_id, message_id')) e(tbl, cols)
  union all
  select 'unique (principal_id, fingerprint): exec_commitments',
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.exec_commitments') and k.contype = 'u'
                   and array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                             order by u.ord) = array['principal_id', 'fingerprint']),
         null
  union all
  select 'principal FK, on delete cascade: ' || e.tbl,
         exists (select 1 from pg_constraint k
                 where k.conrelid = to_regclass('public.' || e.tbl) and k.contype = 'f'
                   and k.confrelid = 'public.exec_principals'::regclass and k.confdeltype = 'c'
                   and array(select a.attname::text from unnest(k.conkey) a0(attnum)
                             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = a0.attnum) = array['principal_id']),
         null
  from (values ('exec_email_threads'), ('exec_commitments'), ('exec_email_signals')) e(tbl)
  union all
  select 'index: ' || e.name, coalesce(x.def = e.def, false), case when x.def is distinct from e.def then coalesce(x.def, '(missing)') end
  from (values
    ('exec_email_threads', 'exec_email_threads_state_idx', 'btree (principal_id, state, last_inbound_at DESC)'),
    ('exec_email_threads', 'exec_email_threads_screen_idx', 'btree (principal_id, screened_policy_hash)'),
    ('exec_email_threads', 'exec_email_threads_expires_idx', 'btree (expires_at)'),
    ('exec_commitments', 'exec_commitments_thread_idx', 'btree (principal_id, thread_id)'),
    ('exec_commitments', 'exec_commitments_due_idx', 'btree (principal_id, status, due_at)'),
    ('exec_commitments', 'exec_commitments_expires_idx', 'btree (expires_at)'),
    ('exec_email_signals', 'exec_email_signals_thread_idx', 'btree (principal_id, thread_id)'),
    ('exec_email_signals', 'exec_email_signals_expires_idx', 'btree (expires_at)')
  ) e(tbl, name, def)
  left join lateral (
    select regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING ', '') as def
    from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = to_regclass('public.' || e.tbl) and ic.relname = e.name
  ) x on true
  union all
  select 'security invoker, pinned search_path: ' || e.fn, coalesce(x.ok, false),
         case when not coalesce(x.ok, false) then coalesce(x.found, '(missing)') end
  from (values ('exec_email_stamp_screened(text,jsonb,text)'), ('exec_email_upsert_signals(text,jsonb)'),
               ('exec_email_insert_commitments(text,text,jsonb)')) e(fn)
  left join lateral (
    select not p.prosecdef and coalesce(p.proconfig::text, '') like '%search_path=%' as ok,
           case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end
             || ', config ' || coalesce(p.proconfig::text, '(none)') as found
    from pg_proc p
    where p.oid = to_regprocedure('public.' || e.fn)
  ) x on true
) checks
order by ok, check_name;
