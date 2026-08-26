-- One-time privacy cleanup: remove what mail at rmreyestaxservices.com already
-- produced inside DelegationDoer, after
-- 20260826000100_restricted_senders_rm_reyes_domain.sql has been applied.
--
-- The restricted_senders rule hides those THREADS from every inbox surface the
-- moment it lands. It does not touch what earlier emails already derived:
-- tasks written from them, auto-reply drafts addressed back to them,
-- routing_decisions rows holding the classifier's summary, and notification
-- rows carrying sender + subject + preview. None of those are sender-filtered
-- at read time. This script removes them.
--
-- Sibling of 20260826_purge_rm_reyes_residue.sql (the firm's Gmail address,
-- match_kind 'exact') and of 20260808_purge_stripe_residue.sql (Stripe,
-- match_kind 'domain'). This one is domain-matched, like the Stripe script.
-- It is a SEPARATE FILE rather than a widening of the exact one on purpose:
-- that script scopes its pattern lookup to `match_kind='exact' and id in
-- ('rs_rmreyes_gmail')` precisely so it can never be repurposed onto a domain,
-- and relaxing that guard to save a file would throw away the protection.
--
--
-- TWO STRUCTURAL DIFFERENCES FROM THE EARLIER SCRIPTS. Both are fixes, not
-- style. Read these before adapting this file for the next vendor.
--
-- 1. IT IS ONE STATEMENT, NOT A TRANSACTION FULL OF TEMP TABLES.
--    The earlier scripts build `create temporary table … on commit drop` and
--    then reference them across later statements. That works in psql. It does
--    NOT work in the Supabase SQL editor, which spreads statements across
--    pooled sessions — the 2026-08-26 run of the exact-rule script died with
--    `relation "reyes_pat" does not exist`. Worse, it died AFTER the deletes
--    had already executed, so the error message actively misrepresented what
--    had happened to the data. A single statement with data-modifying CTEs is
--    atomic on its own, needs no BEGIN/COMMIT, runs everywhere, and returns
--    the deleted counts as its result set.
--
-- 2. THE SINGLE SNAPSHOT IS LOAD-BEARING, NOT INCIDENTAL.
--    Every data-modifying CTE below sees the same snapshot and cannot see the
--    others' effects. That is exactly what this job needs, because
--    email_notifications is BOTH a thing being deleted AND one of the tables
--    the thread set is derived from. Any version that re-derives the thread
--    set per statement would find it empty after the notifications delete and
--    silently skip every thread-keyed table that followed. Do not "simplify"
--    this into sequential statements.
--
--
-- CORRECTION TO A CLAIM IN THE EARLIER SCRIPTS. They assert "Only three DD
-- tables store an email address at all". That was already untrue. A sweep of
-- information_schema for columns matching email/domain/website/participant
-- finds, besides the three they use (email_notifications.from_email,
-- tasks.client_email, email_drafts.to_emails):
--
--   email_drafts.cc_emails, email_drafts.bcc_emails   (they read to_emails only)
--   email_satisfaction_scores.from_address
--   slack_client_email_posts.from_email
--   scheduled_emails.to_emails, scheduled_emails.cc_emails
--   client_meetings.participants
--   outbound_leads.email
--   inbox_assignments.inbox_email
--   clients.contact_emails
--
-- All of them are ZERO for this domain, so nothing changes for this run — but
-- the preview below counts them anyway so the next person reusing this
-- template is not misled by a stale claim.
--
--
-- IT DELIBERATELY STOPS SHORT OF DESTROYING HUMAN WORK. Two carve-outs, both
-- counted separately in the preview so you can see what was spared:
--   * email_drafts is scoped to kind = 'auto_reply'. Drafts a person composed
--     on one of these threads are their words, not the sender's mail.
--   * tasks is scoped to is_draft. An APPROVED intake task may have been
--     assigned and worked, and the hard delete cascades its activity_logs with
--     no task_deletions row to recover from.
-- Measured before writing this: both are 0 for this domain (wordpress@ is
-- already caught by the /^wordpress@/i intake filter, so it never became a
-- task). The carve-outs stay anyway — they cost nothing and the next reuse of
-- this file will not have that luxury.
--
--
-- TWO DELIBERATE DEVIATIONS FROM THIS SCHEMA'S HOUSE PHILOSOPHY:
--
-- 1. HARD delete, not the soft delete of 20260620000000_task_soft_delete.sql.
--    Soft delete is an UPDATE stamping deleted_at — the description, the
--    sender address and the classifier's summary all stay in the row, fully
--    readable to anyone with DB access. This is a privacy cleanup, so the
--    content has to actually go.
--
-- 2. NO task_deletions AUDIT ROW. task_deletions.task_snapshot is a full jsonb
--    copy of the task at delete time — writing one would COPY the email
--    content into a second table rather than remove it. Deliberately skipped.
--    (This is also why you should not do this purge through the app's Delete
--    button, which does write that snapshot.)
--
-- Hard-deleting a task is safe here: every FK into public.tasks is ON DELETE
-- CASCADE (activity_logs, task_handoffs, task_messages, task_notifications,
-- email_draft_tasks) or ON DELETE SET NULL (email_intake_log.task_id,
-- routing_decisions.task_id, task_deletions.task_id, time_entries.task_id).
-- Nothing RESTRICTs, so no delete can be blocked half-way.
--
--
-- ORDER MATTERS — RUN THE MIGRATION FIRST. The intake poller selects "newest
-- 200 open INBOX threads MINUS everything in email_intake_log"
-- (src/lib/email-intake-runner.ts) — no cursor, no time window. With the rule
-- in place, anything re-processed lands on the restricted-sender branch with
-- task_id = null and never reaches the classifier. Without it, re-processing
-- creates fresh tasks — the exact residue this script is deleting. If the
-- migration has not been applied, `pat` below is empty, every CTE yields
-- nothing, and the script is a no-op that deletes zero rows rather than
-- guessing.
--
-- Run it when nobody is clicking "Create task from this thread":
-- getRestrictedSenderRules FAILS OPEN, so if this briefly errors that read,
-- intake reverts to unprotected for the window — and the manual run-once route
-- bypasses looksAutomated, leaving the DB rule as the only defence.


-- ===========================================================================
-- STEP 1 (READ-ONLY) — preview. Run this alone first and read the counts.
-- ===========================================================================
-- Deletes nothing. The last four rows are the completeness check described in
-- the header correction above; they are expected to be 0 and are here so a
-- future reuse notices if they are not.
with pat as (
  -- Read from the rules table, never retyped, so this cannot drift from what
  -- is actually restricted. Scoped to match_kind='domain' as well as the id:
  -- if the rule were ever rewritten, this yields nothing and the whole script
  -- becomes a no-op instead of purging on the wrong pattern.
  select lower(pattern) as pattern
    from public.restricted_senders
   where enabled = true and match_kind = 'domain' and id = 'rs_rmreyes_com'
), addr_threads as (
  select n.thread_id, lower(n.from_email) as addr
    from public.email_notifications n where n.from_email is not null
  union all
  select nullif(split_part(t.missive_thread_url, 'thread=', 2), ''), lower(t.client_email)
    from public.tasks t where t.client_email is not null
  union all
  -- to/cc/bcc, not just to: the earlier scripts read to_emails alone.
  select d.source_thread_id, lower(e)
    from public.email_drafts d
    cross join lateral unnest(
      coalesce(d.to_emails,'{}') || coalesce(d.cc_emails,'{}') || coalesce(d.bcc_emails,'{}')
    ) as e
   where d.source_thread_id is not null
), threads as (
  select distinct a.thread_id
    from addr_threads a
    join pat p
      -- Mirrors addressMatches() for match_kind 'domain': the domain equals
      -- the pattern, or is a true subdomain of it. substring(… from '[^@]*$')
      -- is everything after the LAST '@', which is what lastIndexOf gives.
      on substring(a.addr from '[^@]*$') = p.pattern
      or substring(a.addr from '[^@]*$') like '%.' || p.pattern
   where a.thread_id is not null and a.addr like '%@%'
), tsk as (
  -- The 'email-intake' tag is what keeps this from being a blind sweep:
  -- runEmailIntake always sets it, so a human-written task that merely
  -- mentions this firm is not caught.
  select t.id, t.is_draft
    from public.tasks t
   where t.tags @> array['email-intake']
     and (
       exists (select 1 from pat p
                where t.client_email is not null and t.client_email like '%@%'
                  and (substring(lower(t.client_email) from '[^@]*$') = p.pattern
                    or substring(lower(t.client_email) from '[^@]*$') like '%.' || p.pattern))
       or nullif(split_part(t.missive_thread_url,'thread=',2),'') in (select thread_id from threads)
     )
)
select 'rule pattern (must be rmreyestaxservices.com)' as what, coalesce(max(pattern),'** MISSING **') as n from pat
union all select 'threads identified', count(*)::text from threads
union all select 'email_notifications (DELETE)', count(*)::text from public.email_notifications where thread_id in (select thread_id from threads)
union all select 'routing_decisions (DELETE)', count(*)::text from public.routing_decisions where thread_id in (select thread_id from threads) or task_id in (select id from tsk)
union all select 'email_drafts auto_reply (DELETE)', count(*)::text from public.email_drafts where source_thread_id in (select thread_id from threads) and kind = 'auto_reply'
union all select 'email_drafts human-authored (KEPT)', count(*)::text from public.email_drafts where source_thread_id in (select thread_id from threads) and kind is distinct from 'auto_reply'
union all select 'tasks drafts (DELETE)', count(*)::text from tsk where is_draft
union all select 'tasks approved/worked (KEPT)', count(*)::text from tsk where not is_draft
union all select 'thread_read_state (DELETE)', count(*)::text from public.thread_read_state where thread_id in (select thread_id from threads)
union all select 'email_intake_log (KEPT — see footer)', count(*)::text from public.email_intake_log where thread_id in (select thread_id from threads)
union all select 'slack_client_email_posts (KEPT — see footer)', count(*)::text from public.slack_client_email_posts where thread_id in (select thread_id from threads)
-- Completeness check on the tables the earlier scripts wrongly said did not exist.
union all select 'email_satisfaction_scores (expect 0)', count(*)::text from public.email_satisfaction_scores where lower(coalesce(from_address,'')) like '%@rmreyestaxservices.com' or lower(coalesce(from_address,'')) like '%.rmreyestaxservices.com'
union all select 'scheduled_emails (expect 0)', count(*)::text from public.scheduled_emails s where exists (select 1 from unnest(coalesce(s.to_emails,'{}')||coalesce(s.cc_emails,'{}')) e where lower(e) like '%rmreyestaxservices.com')
union all select 'client_meetings (expect 0)', count(*)::text from public.client_meetings m where exists (select 1 from unnest(coalesce(m.participants,'{}')) p where lower(p) like '%rmreyestaxservices.com')
union all select 'outbound_leads (expect 0)', count(*)::text from public.outbound_leads where lower(coalesce(email,'')) like '%rmreyestaxservices.com';


-- ===========================================================================
-- STEP 2 — the purge. ONE statement. Returns what it deleted.
-- ===========================================================================
-- Measured expectation at the time of writing: email_notifications 6,
-- everything else 0. If the numbers come back materially different, the thread
-- set has moved since the preview — stop and re-read the preview before
-- running anything else.
with pat as (
  select lower(pattern) as pattern
    from public.restricted_senders
   where enabled = true and match_kind = 'domain' and id = 'rs_rmreyes_com'
), addr_threads as (
  select n.thread_id, lower(n.from_email) as addr
    from public.email_notifications n where n.from_email is not null
  union all
  select nullif(split_part(t.missive_thread_url, 'thread=', 2), ''), lower(t.client_email)
    from public.tasks t where t.client_email is not null
  union all
  select d.source_thread_id, lower(e)
    from public.email_drafts d
    cross join lateral unnest(
      coalesce(d.to_emails,'{}') || coalesce(d.cc_emails,'{}') || coalesce(d.bcc_emails,'{}')
    ) as e
   where d.source_thread_id is not null
), threads as (
  select distinct a.thread_id
    from addr_threads a
    join pat p
      on substring(a.addr from '[^@]*$') = p.pattern
      or substring(a.addr from '[^@]*$') like '%.' || p.pattern
   where a.thread_id is not null and a.addr like '%@%'
), tsk as (
  select t.id, t.is_draft
    from public.tasks t
   where t.tags @> array['email-intake']
     and (
       exists (select 1 from pat p
                where t.client_email is not null and t.client_email like '%@%'
                  and (substring(lower(t.client_email) from '[^@]*$') = p.pattern
                    or substring(lower(t.client_email) from '[^@]*$') like '%.' || p.pattern))
       or nullif(split_part(t.missive_thread_url,'thread=',2),'') in (select thread_id from threads)
     )
),
-- from_email + subject + body preview
d_notif as (
  delete from public.email_notifications
   where thread_id in (select thread_id from threads)
  returning 1
),
-- classifier_output is the AI's written summary, readable in the
-- leader-visible needs-review queue
d_routing as (
  delete from public.routing_decisions
   where thread_id in (select thread_id from threads)
      or task_id in (select id from tsk)
  returning 1
),
-- auto-replies only; a human's unsent draft is their work, not residue
d_drafts as (
  delete from public.email_drafts
   where source_thread_id in (select thread_id from threads)
     and kind = 'auto_reply'
  returning 1
),
-- drafts only; an approved task may have been assigned and worked, and the
-- cascade takes its activity_logs with it and leaves nothing to recover from
d_tasks as (
  delete from public.tasks
   where id in (select id from tsk where is_draft)
  returning 1
),
-- per-user read markers: no content, so tidiness rather than privacy
d_read as (
  delete from public.thread_read_state
   where thread_id in (select thread_id from threads)
  returning 1
)
select 'email_notifications' as deleted_from, count(*)::int as n from d_notif
union all select 'routing_decisions',    count(*)::int from d_routing
union all select 'email_drafts (auto_reply only)', count(*)::int from d_drafts
union all select 'tasks (drafts only)',  count(*)::int from d_tasks
union all select 'thread_read_state',    count(*)::int from d_read;


-- ===========================================================================
-- TWO TABLES DELIBERATELY NOT TOUCHED — both are ledgers, not content stores
-- ===========================================================================
--
-- email_intake_log — thread_id, account_id and routed_via only: no sender, no
-- subject, no body. Keeping the rows is what tells the poller these threads
-- are already handled, so they are never re-fetched or re-classified.
-- Deleting them would make the poller re-process every one still in the newest
-- 200 open INBOX threads — harmless now that the rule exists (each row would
-- just be rewritten as routed_via='restricted-sender'), but pointless churn,
-- and it destroys the audit trail of what was handled when.
--
-- slack_client_email_posts — this one LOOKS like purge material, because it
-- carries from_email and the subject. It is not: it is the dedupe LOCK for the
-- #email-notifs Slack post. src/lib/client-email-slack.ts documents it —
-- a message reaches DD by three paths (HMAC webhook, socket bridge, safety-net
-- poll) and prod runs more than one instance, so every path INSERTs on
-- message_id BEFORE calling Slack and the loser backs off on 23505. Delete a
-- row here and a later re-delivery of that message is free to post to Slack
-- again. Leave it.
--
-- To relabel the intake log for clarity instead — optional, safe, no
-- re-processing:
--
--   with pat as (
--     select lower(pattern) as pattern from public.restricted_senders
--      where enabled = true and match_kind = 'domain' and id = 'rs_rmreyes_com')
--   update public.email_intake_log set routed_via = 'restricted-sender', task_id = null
--    where thread_id in ( … the threads CTE above … );
