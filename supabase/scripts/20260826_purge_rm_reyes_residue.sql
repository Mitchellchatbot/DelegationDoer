-- One-time privacy cleanup: remove what mail from rmreyestaxservices@gmail.com
-- already produced inside DelegationDoer, after
-- 20260826000000_restricted_senders_rm_reyes.sql has been applied.
--
-- The restricted_senders rule hides those THREADS from every inbox surface the
-- moment it lands. It does not touch what earlier emails already derived:
-- tasks written from them, auto-reply drafts addressed back to them,
-- routing_decisions rows holding the classifier's summary, and notification
-- rows carrying sender + subject + preview. None of those are sender-filtered
-- at read time. This script removes them.
--
-- Sibling of supabase/scripts/20260808_purge_stripe_residue.sql, which did the
-- same job for Stripe. ONE STRUCTURAL DIFFERENCE, and it is the whole reason
-- this is a separate file rather than a re-run of that one: rs_rmreyes_gmail
-- is an 'exact' rule, not a 'domain' rule, so address matching here is plain
-- equality rather than "domain equals, or is a subdomain of, the pattern".
-- Mirroring addressMatches() in src/lib/restricted-senders.ts is the point —
-- a purge that matched more broadly than the rule would delete mail that is
-- still visible in the app, and one that matched more narrowly would leave
-- readable residue behind. See step 0.
--
-- IT DELIBERATELY STOPS SHORT OF DESTROYING HUMAN WORK. Two carve-outs, both
-- counted separately in the preview so you can see what was spared:
--   * email_drafts is scoped to kind = 'auto_reply'. Drafts a person composed
--     on one of these threads are their words, not the sender's mail (step 4).
--   * tasks is scoped to is_draft. An APPROVED intake task may have been
--     assigned and worked, and the hard delete cascades its activity_logs with
--     no task_deletions row to recover from. Opt in explicitly if you want
--     those gone too (step 5).
-- Both carve-outs leave some of this sender's text in DD. That is the safer
-- default; widening it is one un-comment away, narrowing a bad delete is not.
--
-- NOTE ON THIS PARTICULAR SENDER. Deel and Stripe are automated billers, and
-- the Stripe run found 0 tasks and 0 email_drafts — nothing human existed to
-- spare. This is a HUMAN correspondent (an accountant), so approved tasks and
-- hand-written drafts are genuinely plausible here in a way they were not
-- there. Read the two task counts and the human-drafts count in the preview
-- before you commit; do not assume they are zero.
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
-- email_intake_log rows are DELIBERATELY LEFT IN PLACE — see step 6.
--
-- Run this when nobody is clicking "Create task from this thread":
-- getRestrictedSenderRules FAILS OPEN, so if this script briefly errors that
-- read, intake reverts to unprotected for the window — and the manual
-- run-once route bypasses looksAutomated, leaving the DB rule as the only
-- defence.

begin;

-- ---------------------------------------------------------------------------
-- 0) Work out which threads are this sender's.
-- ---------------------------------------------------------------------------
-- Only three DD tables store an email address at all; the rest are keyed by
-- Missive thread id (the clone is the source of truth for the thread itself).
-- So we recover the thread-id set from the address-bearing tables, then drive
-- every thread-keyed delete from that set.
--
-- The pattern is READ FROM THE RULES TABLE rather than retyped, so this script
-- can never drift from what is actually restricted. Matching mirrors
-- addressMatches() in src/lib/restricted-senders.ts exactly — for match_kind
-- 'exact' that is FULL-ADDRESS EQUALITY on the lower-cased address, and
-- nothing else. Never a substring or domain test: '%gmail.com' would sweep in
-- every personal address we correspond with, and '%reyes%' would match an
-- unrelated person with that surname.
--
-- Scoped to match_kind = 'exact' as well as the id, so that if someone ever
-- rewrites rs_rmreyes_gmail as a 'domain' rule (the mistake the migration
-- header warns about) this script selects nothing and the guard below aborts,
-- rather than quietly purging on gmail.com.

create temporary table reyes_patterns on commit drop as
select lower(pattern) as pattern
  from public.restricted_senders
 where enabled = true
   and match_kind = 'exact'
   and id in ('rs_rmreyes_gmail');

-- Guard: if the migration has not been applied, stop now rather than delete
-- nothing and report success.
do $$
begin
  if (select count(*) from reyes_patterns) = 0 then
    raise exception
      'No enabled exact rule found for rs_rmreyes_gmail. Apply supabase/migrations/20260826000000_restricted_senders_rm_reyes.sql first.';
  end if;
end $$;

-- OPTIONAL — paste the thread ids from the clone census here:
--   GET {MISSIVE_API_URL}/api/threads?q=rmreyestaxservices   (bearer MISSIVE_API_TOKEN)
--
-- Needed only for threads that left NO address-bearing artifact — e.g. one
-- that was classified as non-actionable (a routing_decisions row with
-- task_id null and no task, no notification), or one that was merely read in
-- the inbox (a thread_read_state row). Those cannot be identified from DD
-- alone, because none of those tables stores a sender. Leave it empty to
-- purge only what is discoverable in-database.
create temporary table reyes_threads_from_clone (thread_id text primary key) on commit drop;
-- insert into reyes_threads_from_clone (thread_id) values
--   ('<thread id>'), ('<thread id>');

create temporary table reyes_threads on commit drop as
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
  -- practice). It does not matter for completeness: step 0's reyes_tasks
  -- matches tasks on client_email directly, so a task is still caught even if
  -- its URL-derived thread id is not. This branch only widens the THREAD set.
  select nullif(split_part(t.missive_thread_url, 'thread=', 2), ''), lower(t.client_email)
    from public.tasks t
   where t.client_email is not null
  union all
  -- email_drafts.to_emails is [fromEmail] for auto-replies. This is also the
  -- branch that catches OUR OUTBOUND side of the correspondence, which the
  -- rule hides too (matching is correspondent-wide).
  select d.source_thread_id, lower(e)
    from public.email_drafts d
    cross join lateral unnest(d.to_emails) as e
   where d.source_thread_id is not null
)
select thread_id from (
  select a.thread_id
    from addr_threads a
    join reyes_patterns p
      -- Full-address equality: match_kind 'exact'. Not a domain comparison.
      on a.addr = p.pattern
   where a.thread_id is not null
  union
  select thread_id from reyes_threads_from_clone
) s;

-- Tasks to remove. Requiring the 'email-intake' tag is what keeps this from
-- being a blind sweep: runEmailIntake always sets it, so every task derived
-- from an email carries it, and a human-written task that merely mentions this
-- sender does not.
create temporary table reyes_tasks on commit drop as
select t.id
  from public.tasks t
 where t.tags @> array['email-intake']
   and (
     exists (
       select 1 from reyes_patterns p
        where t.client_email is not null
          and lower(t.client_email) = p.pattern
     )
     or nullif(split_part(t.missive_thread_url, 'thread=', 2), '')
          in (select thread_id from reyes_threads)
   );

-- ---------------------------------------------------------------------------
-- 1) PREVIEW — the full blast radius, before anything is mutated.
-- ---------------------------------------------------------------------------
select 'threads identified' as what, count(*) as n from reyes_threads
union all
select 'tasks: drafts (DELETED below)', count(*) from public.tasks
 where id in (select id from reyes_tasks) and is_draft
union all
-- Not deleted by default. These are intake tasks somebody APPROVED, and
-- possibly assigned and worked; hard-deleting them cascades their
-- activity_logs, i.e. their work history. See step 5. Unlike the Stripe run,
-- expect these to be non-zero: this is a human correspondent.
select 'tasks: approved/worked (KEPT — opt in at step 5)', count(*) from public.tasks
 where id in (select id from reyes_tasks) and not is_draft
union all
select 'email_notifications',          count(*) from public.email_notifications
 where thread_id in (select thread_id from reyes_threads)
union all
select 'routing_decisions',            count(*) from public.routing_decisions
 where thread_id in (select thread_id from reyes_threads)
    or task_id in (select id from reyes_tasks)
union all
select 'email_drafts: auto_reply (DELETED below)', count(*) from public.email_drafts
 where source_thread_id in (select thread_id from reyes_threads)
   and kind = 'auto_reply'
union all
-- Not deleted. A human composed these; they are the team's own words, not
-- residue of the inbound mail. See step 4.
select 'email_drafts: human-authored (KEPT)', count(*) from public.email_drafts
 where source_thread_id in (select thread_id from reyes_threads)
   and (kind is distinct from 'auto_reply')
union all
select 'thread_read_state',            count(*) from public.thread_read_state
 where thread_id in (select thread_id from reyes_threads)
union all
select 'email_intake_log (KEPT, not deleted)', count(*) from public.email_intake_log
 where thread_id in (select thread_id from reyes_threads);

-- Eyeball it. "DELETE" rows go in step 5; "KEEP" rows survive unless you
-- un-comment the opt-in there.
select case when is_draft then 'DELETE' else 'KEEP' end as fate,
       id, status, is_draft, client_email, left(title, 80) as title
  from public.tasks
 where id in (select id from reyes_tasks)
 order by is_draft, created_at desc;

-- SANITY CHECK — this must return exactly one row reading
-- 'rmreyestaxservices@gmail.com'. If it shows anything else (or more than one
-- row), ROLLBACK: the pattern set is not what you think it is and every delete
-- below is driven by it.
select pattern from reyes_patterns;

-- ---------------------------------------------------------------------------
-- 2) email_notifications — carries from_email, subject and a body preview.
-- ---------------------------------------------------------------------------
delete from public.email_notifications
 where thread_id in (select thread_id from reyes_threads);

-- ---------------------------------------------------------------------------
-- 3) routing_decisions — classifier_output is the AI's written summary of the
--    email, readable in the leader-visible needs-review queue. Deleted rather
--    than soft-cleared (the precedent script at
--    20260601_purge_unsummarized_intake_drafts.sql only flips needs_review,
--    which would leave the summary in place).
-- ---------------------------------------------------------------------------
delete from public.routing_decisions
 where thread_id in (select thread_id from reyes_threads)
    or task_id in (select id from reyes_tasks);

-- ---------------------------------------------------------------------------
-- 4) email_drafts — machine-generated auto-replies addressed back to this
--    sender, sitting unsent in /approvals. email_draft_tasks cascades.
--
--    SCOPED TO kind = 'auto_reply' ON PURPOSE. This table also holds drafts a
--    HUMAN composed. If someone has written an unsent reply on one of these
--    threads, that is their work, not residue of the inbound mail, and
--    deleting it would destroy it silently. The preview above counts them
--    separately so you can see whether any exist; deal with those by hand.
-- ---------------------------------------------------------------------------
delete from public.email_drafts
 where source_thread_id in (select thread_id from reyes_threads)
   and kind = 'auto_reply';

-- ---------------------------------------------------------------------------
-- 5) tasks — hard delete, no task_deletions snapshot (see header).
--    Cascades activity_logs / task_handoffs / task_messages /
--    task_notifications; NULLs email_intake_log.task_id, which is exactly the
--    shape a restricted-sender log row has anyway.
--
--    DRAFTS ONLY BY DEFAULT. An intake task starts life as is_draft = true,
--    sitting in the routing-review queue, and deleting one destroys nothing a
--    person did. A task somebody APPROVED is different: it may have been
--    assigned, commented on and worked, and the hard delete cascades its
--    activity_logs, i.e. its whole history — with no task_deletions row to
--    recover from, since we deliberately skip that snapshot (see header). That
--    is not a thing to do silently as a side effect of a privacy cleanup.
--
--    The trade-off, stated plainly: a surviving approved task still carries the
--    classifier's description and a "_From: rmreyestaxservices@gmail.com_"
--    line, so it is still content derived from this sender living in DD. Read
--    the two task counts in the preview. If the approved ones should go too,
--    un-comment the second statement — the preview's detail query lists
--    exactly what it would remove.
-- ---------------------------------------------------------------------------
delete from public.tasks
 where id in (select id from reyes_tasks)
   and is_draft;

-- OPT-IN: also remove approved/worked intake tasks derived from this sender.
-- delete from public.tasks
--  where id in (select id from reyes_tasks)
--    and not is_draft;

-- ---------------------------------------------------------------------------
-- 6) thread_read_state — per-user read markers. No content (user, thread,
--    timestamps), so this is tidiness rather than privacy.
-- ---------------------------------------------------------------------------
delete from public.thread_read_state
 where thread_id in (select thread_id from reyes_threads);

-- ---------------------------------------------------------------------------
-- 7) email_intake_log — DELIBERATELY NOT DELETED.
-- ---------------------------------------------------------------------------
-- These rows hold thread_id, account_id and routed_via only: no sender, no
-- subject, no body. Keeping them is what tells the poller the thread is
-- already handled, so it is never re-fetched or re-classified. Deleting them
-- would make the poller re-process every one of these threads still in the
-- newest 200 open INBOX threads — harmless now that the rule exists (it would
-- just rewrite each row as routed_via='restricted-sender'), but pointless
-- churn against the classifier's neighbours, and it destroys the audit trail
-- of what was handled when.
--
-- To relabel them for clarity instead — optional, safe, no re-processing:
-- update public.email_intake_log
--    set routed_via = 'restricted-sender', task_id = null
--  where thread_id in (select thread_id from reyes_threads);

-- ---------------------------------------------------------------------------
-- Inspect the preview counts above, then:
--   COMMIT;    -- to apply
-- or
--   ROLLBACK;  -- to back out
-- ---------------------------------------------------------------------------
commit;
