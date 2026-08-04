-- One-time privacy cleanup: remove what Stripe mail already produced inside
-- DelegationDoer, after 20260808000000_restricted_senders_stripe.sql has been
-- applied.
--
-- The restricted_senders rule hides Stripe THREADS from every inbox surface
-- the moment it lands. It does not touch what earlier Stripe emails already
-- derived: tasks written from them, auto-reply drafts addressed back to them,
-- routing_decisions rows holding the classifier's summary, and notification
-- rows carrying sender + subject + preview. None of those are sender-filtered
-- at read time. This script removes them.
--
-- This is data cleanup, NOT a schema migration — run it manually once against
-- your Supabase project (SQL editor or psql), inside the transaction below so
-- you can inspect the preview counts and ROLLBACK if anything looks off.
--
-- PREFER psql. The Supabase SQL editor renders only the LAST result set, so
-- pasting the whole file at once hides the preview counts in step 1 — the
-- entire point of the exercise. In the editor, run everything up to and
-- including step 1 first, read the counts, and only then run the rest.
--
-- ORDER MATTERS — RUN THE MIGRATION FIRST.
-- The intake poller selects "newest 200 open INBOX threads MINUS everything in
-- email_intake_log" (src/lib/email-intake-runner.ts) — no cursor, no time
-- window. With the rule in place, anything re-processed lands on the
-- restricted-sender branch with task_id = null and never reaches the
-- classifier. Without it, re-processing creates fresh tasks — the exact
-- residue this script is deleting.
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
--    copy of the task at delete time — writing one would COPY the Stripe email
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
-- email_intake_log rows are DELIBERATELY LEFT IN PLACE — see step 6.
--
-- Run this when nobody is clicking "Create task from this thread":
-- getRestrictedSenderRules FAILS OPEN, so if this script briefly errors that
-- read, intake reverts to unprotected for the window — and the manual
-- run-once route bypasses looksAutomated, leaving the DB rule as the only
-- defence.

begin;

-- ---------------------------------------------------------------------------
-- 0) Work out which threads are Stripe's.
-- ---------------------------------------------------------------------------
-- Only three DD tables store an email address at all; the rest are keyed by
-- Missive thread id (the clone is the source of truth for the thread itself).
-- So we recover the thread-id set from the address-bearing tables, then drive
-- every thread-keyed delete from that set.
--
-- The patterns are READ FROM THE RULES TABLE rather than retyped, so this
-- script can never drift from what is actually restricted. Matching mirrors
-- addressMatches() in src/lib/restricted-senders.ts exactly: the domain equals
-- the pattern, or is a true subdomain of it. Never a substring test —
-- '%stripe%' would sweep in stripecustomer.com and stripe.com.evil.tld.

create temporary table stripe_patterns on commit drop as
select lower(pattern) as pattern
  from public.restricted_senders
 where enabled = true
   and match_kind = 'domain'
   and id in ('rs_stripe_com', 'rs_stripe_dev');

-- Guard: if the migration has not been applied, stop now rather than delete
-- nothing and report success.
do $$
begin
  if (select count(*) from stripe_patterns) = 0 then
    raise exception
      'No enabled Stripe rules found. Apply supabase/migrations/20260808000000_restricted_senders_stripe.sql first.';
  end if;
end $$;

-- OPTIONAL — paste the thread ids from the clone census here:
--   GET {MISSIVE_API_URL}/api/threads?q=stripe   (bearer MISSIVE_API_TOKEN)
--
-- Needed only for threads that left NO address-bearing artifact — e.g. one
-- that was classified as non-actionable (a routing_decisions row with
-- task_id null and no task, no notification), or one that was merely read in
-- the inbox (a thread_read_state row). Those cannot be identified from DD
-- alone, because none of those tables stores a sender. Leave it empty to
-- purge only what is discoverable in-database.
create temporary table stripe_threads_from_clone (thread_id text primary key) on commit drop;
-- insert into stripe_threads_from_clone (thread_id) values
--   ('<thread id>'), ('<thread id>');

create temporary table stripe_threads on commit drop as
with addr_threads as (
  -- email_notifications.from_email is the bare address (splitAddress()).
  select n.thread_id, lower(n.from_email) as addr
    from public.email_notifications n
   where n.from_email is not null
  union all
  -- tasks.client_email is the inbound fromEmail; the thread id is embedded in
  -- missive_thread_url, written as "{MISSIVE_API_URL}/?thread=<id>".
  -- The id goes through encodeURIComponent on the way in, so this extraction
  -- is exact only for ids with no reserved characters (they are opaque ids in
  -- practice). It does not matter for completeness: step 0's stripe_tasks
  -- matches tasks on client_email directly, so a task is still caught even if
  -- its URL-derived thread id is not. This branch only widens the THREAD set.
  select nullif(split_part(t.missive_thread_url, 'thread=', 2), ''), lower(t.client_email)
    from public.tasks t
   where t.client_email is not null
  union all
  -- email_drafts.to_emails is [fromEmail] for auto-replies.
  select d.source_thread_id, lower(e)
    from public.email_drafts d
    cross join lateral unnest(d.to_emails) as e
   where d.source_thread_id is not null
)
select thread_id from (
  select a.thread_id
    from addr_threads a
    join stripe_patterns p
      -- substring(... from '[^@]*$') is everything after the LAST '@', which
      -- is what addressMatches uses (lastIndexOf).
      on substring(a.addr from '[^@]*$') = p.pattern
      or substring(a.addr from '[^@]*$') like '%.' || p.pattern
   where a.thread_id is not null
     and a.addr like '%@%'
  union
  select thread_id from stripe_threads_from_clone
) s;

-- Tasks to remove. Requiring the 'email-intake' tag is what keeps this from
-- being a blind sweep: runEmailIntake always sets it, so every task derived
-- from an email carries it, and a human-written task that merely mentions
-- Stripe does not.
create temporary table stripe_tasks on commit drop as
select t.id
  from public.tasks t
 where t.tags @> array['email-intake']
   and (
     exists (
       select 1 from stripe_patterns p
        where t.client_email is not null
          and t.client_email like '%@%'
          and (substring(lower(t.client_email) from '[^@]*$') = p.pattern
            or substring(lower(t.client_email) from '[^@]*$') like '%.' || p.pattern)
     )
     or nullif(split_part(t.missive_thread_url, 'thread=', 2), '')
          in (select thread_id from stripe_threads)
   );

-- ---------------------------------------------------------------------------
-- 1) PREVIEW — the full blast radius, before anything is mutated.
-- ---------------------------------------------------------------------------
select 'stripe threads identified' as what, count(*) as n from stripe_threads
union all
select 'tasks (hard delete)',          count(*) from stripe_tasks
union all
select 'email_notifications',          count(*) from public.email_notifications
 where thread_id in (select thread_id from stripe_threads)
union all
select 'routing_decisions',            count(*) from public.routing_decisions
 where thread_id in (select thread_id from stripe_threads)
    or task_id in (select id from stripe_tasks)
union all
select 'email_drafts',                 count(*) from public.email_drafts
 where source_thread_id in (select thread_id from stripe_threads)
union all
select 'thread_read_state',            count(*) from public.thread_read_state
 where thread_id in (select thread_id from stripe_threads)
union all
select 'email_intake_log (KEPT, not deleted)', count(*) from public.email_intake_log
 where thread_id in (select thread_id from stripe_threads);

-- Eyeball what is about to be destroyed. Comment out once you trust it.
select id, status, is_draft, client_email, left(title, 80) as title
  from public.tasks
 where id in (select id from stripe_tasks)
 order by created_at desc;

-- ---------------------------------------------------------------------------
-- 2) email_notifications — carries from_email, subject and a body preview.
-- ---------------------------------------------------------------------------
delete from public.email_notifications
 where thread_id in (select thread_id from stripe_threads);

-- ---------------------------------------------------------------------------
-- 3) routing_decisions — classifier_output is the AI's written summary of the
--    email, readable in the leader-visible needs-review queue. Deleted rather
--    than soft-cleared (the precedent script at
--    20260601_purge_unsummarized_intake_drafts.sql only flips needs_review,
--    which would leave the summary in place).
-- ---------------------------------------------------------------------------
delete from public.routing_decisions
 where thread_id in (select thread_id from stripe_threads)
    or task_id in (select id from stripe_tasks);

-- ---------------------------------------------------------------------------
-- 4) email_drafts — unsent auto-replies addressed back to Stripe, sitting in
--    /approvals. email_draft_tasks cascades.
-- ---------------------------------------------------------------------------
delete from public.email_drafts
 where source_thread_id in (select thread_id from stripe_threads);

-- ---------------------------------------------------------------------------
-- 5) tasks — hard delete, no task_deletions snapshot (see header).
--    Cascades activity_logs / task_handoffs / task_messages /
--    task_notifications; NULLs email_intake_log.task_id, which is exactly the
--    shape a restricted-sender log row has anyway.
-- ---------------------------------------------------------------------------
delete from public.tasks
 where id in (select id from stripe_tasks);

-- ---------------------------------------------------------------------------
-- 6) thread_read_state — per-user read markers. No content (user, thread,
--    timestamps), so this is tidiness rather than privacy.
-- ---------------------------------------------------------------------------
delete from public.thread_read_state
 where thread_id in (select thread_id from stripe_threads);

-- ---------------------------------------------------------------------------
-- 7) email_intake_log — DELIBERATELY NOT DELETED.
-- ---------------------------------------------------------------------------
-- These rows hold thread_id, account_id and routed_via only: no sender, no
-- subject, no body. Keeping them is what tells the poller the thread is
-- already handled, so it is never re-fetched or re-classified. Deleting them
-- would make the poller re-process every Stripe thread still in the newest 200
-- open INBOX threads — harmless now that the rule exists (it would just
-- rewrite each row as routed_via='restricted-sender'), but pointless churn
-- against the classifier's neighbours, and it destroys the audit trail of what
-- was handled when.
--
-- To relabel them for clarity instead — optional, safe, no re-processing:
-- update public.email_intake_log
--    set routed_via = 'restricted-sender', task_id = null
--  where thread_id in (select thread_id from stripe_threads);

-- ---------------------------------------------------------------------------
-- Inspect the preview counts above, then:
--   COMMIT;    -- to apply
-- or
--   ROLLBACK;  -- to back out
-- ---------------------------------------------------------------------------
commit;
