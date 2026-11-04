-- Executive AI Assistant, P3: DD follow-up to the clone's MESSAGE DEDUPE
-- (missiveclone backend/scripts/dedupe_messages.sql, §5 deletes and §6 thread
-- re-points).
--
-- HAND-RUN in the Supabase SQL editor, AFTER the dedupe's §6 has run. Never
-- run by the app or by Claude. Its twin, 20261105_exec_p3_split_repair_followup.sql,
-- has the same body for the thread-split repair.
--
-- WHY. The dedupe deleted duplicate message rows and re-pointed (then
-- deleted) loser threads it emptied. The assistant keys everything on clone
-- ids: a thread row whose newest message was a deleted copy points at a row
-- that is gone, a commitment or Outlook signal can hang off a deleted copy,
-- and a re-pointed loser thread's rows describe a thread that no longer
-- exists. This removes the exec rows of every affected thread id and has the
-- assistant re-read each surviving thread from scratch.
--
-- INPUT: (from_thread_id, to_thread_id) pairs. For a loser thread §6
-- re-pointed and deleted: (loser thread, target thread). For a thread that
-- only lost duplicate copies and still exists: (thread, thread). Fill the
-- INPUT section below in ONE of two ways:
--   a. paste them as VALUES rows; or
--   b. uncomment the INSERT that reads them from the dedupe's own log and
--      backup tables (missive.dedup_log_20260922, action 'thread-deleted';
--      missive.dedup_bak_messages_20260922, the deleted copies).
-- Run unedited, the script aborts and changes nothing.
--
-- WHAT IT DOES, for every pair, in one transaction:
--   1. notes which principals had anything on either id, and which thread
--      survived (to_thread_id);
--   2. deletes, for BOTH ids: exec_email_threads, exec_commitments,
--      exec_email_signals rows, and the email attention rows of those threads
--      (fingerprints email:thread:<id>:... and email:commitment:<id>:...);
--   3. queues a re-triage of each surviving thread for each of those
--      principals: an exec.email-triage job on the bulk lane, key
--      retriage:<principal>:<thread>:runbook:<UTC date>, payload
--      { threadId, reason: "runbook" }, max 10 attempts, spaced 20 s apart
--      on the principal's shared stagger (exec_sync_state mail/stagger), so
--      the bulk lane is never flooded; a key already used today is skipped;
--   4. clears the reconcile cursors (exec_sync_state mail/recon:*), so the
--      next reconcile run re-reads the backfill window.
-- It does NOT reset any snapshot_* column: reads after the dedupe are
-- ordered after it already (contract A4), and a reset would let a stale job
-- leave a truncated tombstone (amendments-7(c)).
--
-- Nothing here reads or writes message content. Needs the P3 migration.
-- Re-running it the same day is harmless (rows are already gone, job keys
-- already used).

set local lock_timeout = '5s';

create temp table exec_p3_thread_pairs (from_thread_id text not null, to_thread_id text not null) on commit drop;

-- ---------------------------------------------------------------------------
-- BEGIN INPUT: paste pairs as VALUES rows, one per line, each ending in a
-- comma, above the (null, null) line, which is ignored:
--   ('<affected thread id>', '<surviving thread id>'),
insert into exec_p3_thread_pairs (from_thread_id, to_thread_id)
select v.from_thread_id, v.to_thread_id
  from (values
    (null::text, null::text)
  ) v(from_thread_id, to_thread_id)
 where v.from_thread_id is not null and v.to_thread_id is not null;
-- ...or read them from the dedupe's log and backup instead (uncomment):
-- insert into exec_p3_thread_pairs (from_thread_id, to_thread_id)
-- select distinct l.row_id, l.to_id from missive.dedup_log_20260922 l where l.action = 'thread-deleted' and l.to_id is not null
-- union
-- select distinct b.thread_id, b.thread_id from missive.dedup_bak_messages_20260922 b
--  where exists (select 1 from missive.threads t where t.id = b.thread_id);
-- END INPUT
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  if to_regclass('public.exec_email_threads') is null or to_regclass('public.exec_email_signals') is null then
    raise exception 'follow-up aborted, nothing changed: the P3 tables do not exist (apply 20261105100000_exec_email.sql first)';
  end if;
  select count(*) into n from exec_p3_thread_pairs;
  if n = 0 then
    raise exception 'follow-up aborted, nothing changed: no thread pairs (fill in the INPUT section first)';
  end if;
  if exists (select 1 from exec_p3_thread_pairs
              where char_length(from_thread_id) not between 1 and 200 or char_length(to_thread_id) not between 1 and 200) then
    raise exception 'follow-up aborted, nothing changed: a thread id is empty or longer than 200 characters';
  end if;
end $$;

create temp table exec_p3_report (ord int, step text, n bigint) on commit drop;

-- Every id the repair touched, and the surviving thread of each pair.
create temp table exec_p3_ids on commit drop as
select from_thread_id as thread_id from exec_p3_thread_pairs
union
select to_thread_id from exec_p3_thread_pairs;

-- 1. Who had anything on either id: their surviving threads get re-triaged.
create temp table exec_p3_retriage on commit drop as
select distinct x.principal_id, pr.to_thread_id as thread_id
  from exec_p3_thread_pairs pr
  cross join lateral (
    select t.principal_id from public.exec_email_threads t where t.thread_id in (pr.from_thread_id, pr.to_thread_id)
    union
    select c.principal_id from public.exec_commitments c where c.thread_id in (pr.from_thread_id, pr.to_thread_id)
    union
    select s.principal_id from public.exec_email_signals s where s.thread_id in (pr.from_thread_id, pr.to_thread_id)
  ) x;

-- 2. Delete the exec rows of both ids.
with d as (delete from public.exec_email_threads t using exec_p3_ids i where t.thread_id = i.thread_id returning 1)
insert into exec_p3_report select 1, 'exec_email_threads deleted', count(*) from d;
with d as (delete from public.exec_commitments c using exec_p3_ids i where c.thread_id = i.thread_id returning 1)
insert into exec_p3_report select 2, 'exec_commitments deleted', count(*) from d;
with d as (delete from public.exec_email_signals s using exec_p3_ids i where s.thread_id = i.thread_id returning 1)
insert into exec_p3_report select 3, 'exec_email_signals deleted', count(*) from d;
-- email:thread:<thread id>:<anchor id> and email:commitment:<thread id>:<commitment id>.
-- The last segment (a clone message id, a commitment id) never holds a ':'.
with d as (
  delete from public.exec_attention_items a
   using exec_p3_ids i
   where a.source = 'email'
     and substring(a.fingerprint from '^email:(?:thread|commitment):(.+):[^:]+$') = i.thread_id
  returning 1
)
insert into exec_p3_report select 4, 'email attention rows deleted', count(*) from d;

-- 3. Re-triage each surviving thread, through the principal's shared stagger.
do $$
declare
  r record;
  v_cursor jsonb;
  v_last timestamptz;
  v_rev bigint;
  v_base timestamptz;
  v_n bigint;
  v_total bigint := 0;
  v_day text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
begin
  for r in
    select principal_id, array_agg(thread_id order by thread_id) as threads
      from exec_p3_retriage
     group by principal_id
     order by principal_id
  loop
    -- The stagger position (sync-state.ts mail/stagger: { rev, lastRunAfter }), locked for the update.
    insert into public.exec_sync_state (principal_id, source, key, cursor, updated_at)
    values (r.principal_id, 'mail', 'stagger', jsonb_build_object('rev', 0, 'lastRunAfter', null), now())
    on conflict (principal_id, source, key) do nothing;
    select s.cursor into v_cursor
      from public.exec_sync_state s
     where s.principal_id = r.principal_id and s.source = 'mail' and s.key = 'stagger'
       for update;
    v_rev := case when v_cursor->>'rev' ~ '^[0-9]{1,15}$' then (v_cursor->>'rev')::bigint else 0 end;
    v_last := case when v_cursor->>'lastRunAfter' ~ '^\d{4}-\d{2}-\d{2}T' then (v_cursor->>'lastRunAfter')::timestamptz end;
    -- 20 s after the last slot handed out, never before now.
    v_base := greatest(now(), coalesce(v_last + interval '20 seconds', now()));

    insert into public.exec_jobs (kind, lane, principal_id, payload, dedupe_key, max_attempts, run_after)
    select 'exec.email-triage', 'bulk', r.principal_id,
           jsonb_build_object('threadId', t.thread_id, 'reason', 'runbook'),
           'retriage:' || r.principal_id || ':' || t.thread_id || ':runbook:' || v_day,
           10,
           v_base + make_interval(secs => 20 * (t.ord - 1))
      from unnest(r.threads) with ordinality t(thread_id, ord)
    on conflict (dedupe_key) do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    update public.exec_sync_state s
       set cursor = jsonb_build_object(
             'rev', v_rev + 1,
             'lastRunAfter', to_char((v_base + make_interval(secs => 20 * (cardinality(r.threads) - 1))) at time zone 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
           updated_at = now()
     where s.principal_id = r.principal_id and s.source = 'mail' and s.key = 'stagger';
  end loop;
  insert into exec_p3_report values (5, 're-triage jobs queued', v_total);
end $$;

-- 4. Clear the reconcile cursors.
with d as (delete from public.exec_sync_state s where s.source = 'mail' and s.key like 'recon:%' returning 1)
insert into exec_p3_report select 6, 'reconcile cursors cleared (mail/recon:*)', count(*) from d;

select step, n from exec_p3_report order by ord;
