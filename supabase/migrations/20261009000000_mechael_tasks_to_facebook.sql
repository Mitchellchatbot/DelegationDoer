-- =============================================================================
-- Move FOUR named tasks of Mechael's into the Facebook department.
--
-- The department is not a label on these: the proof/approval flow is gated
-- purely on the TASK's department (isFb in src/app/(main)/tasks/[id]/page.tsx,
-- and the 400 "not a Facebook task" guard in
-- api/tasks/[id]/submit-proof/route.ts). Moving them is what turns sign-off on.
-- It also means she can no longer mark them Done directly -- api/tasks/[id]
-- returns 400 "Facebook tasks need a proof submission" -- so each one now
-- needs a photo, notes and a manager's review to close. That is the intent,
-- but it lands on work already in flight; tell her and the approver first.
--
-- NAMED, NOT "ALL HER OPEN WORK". An earlier draft of this file matched every
-- open task she holds. That was too broad: "Investigate email sending issue
-- reported" is Software work and stays Software. So the four are matched by
-- a distinctive fragment of each title, one row per target, and the block
-- below REFUSES TO RUN unless each fragment matches exactly one task. Over-
-- matching and under-matching both abort rather than quietly doing the wrong
-- thing, and the report lists what is being left behind as well as what moves.
--
-- Fragments rather than whole titles on purpose: a title carries typos
-- ("Passsage"), hyphens that may be en-dashes, and quotes that may be curly,
-- none of which survive a round trip through a screenshot. A fragment with no
-- punctuation in it cannot be defeated by any of that, and the exactly-one
-- guard is what keeps it precise.
--
-- Deliberately untouched:
--   * Her other open tasks -- see above.
--   * last_activity_at. Re-filing a task is not work on it, and bumping it
--     would reset every "stalled 48h+" badge; three of these are stalled.
--   * Her primary department, and any Slack routing. Re-filing an already
--     created, already assigned task posts nothing: announcements fire at
--     creation, the claim path needs an unassigned task, and the inactivity
--     digest only covers unassigned team tasks.
--
-- HOW TO RUN -- PREVIEW FIRST:
--   1. Paste the whole file into the Supabase SQL editor and run it. v_apply
--      is false, so NOTHING is written. The result grid shows every open task
--      she holds, each marked MOVE or leave. Confirm exactly four say MOVE and
--      that the email task says leave.
--   2. SCREENSHOT THAT GRID. from_department is the only record of where each
--      task came from, and it is what you would need to undo this.
--   3. Then set `v_apply boolean := false` to `true` and run the file again.
--      Re-runnable; it converges.
--
-- RAISE NOTICE is invisible in the Supabase SQL editor, so the report below is
-- a plain trailing SELECT and anything genuinely dangerous is an exception.
-- =============================================================================

-- Top-of-file drops, not trailing ones: a trailing drop would hide the report,
-- and this makes a re-run after an aborted attempt clean.
drop table if exists _mechael_move;
drop table if exists _mechael_open;
drop table if exists _mechael_targets;

-- The four, one row each. `label` is only for the report.
create temp table _mechael_targets (pattern text primary key, label text);
insert into _mechael_targets (pattern, label) values
  ('%formreactor%',                'Setup formreactor for Arrow Passsage'),
  ('%Two Pipelines%',              'Create Two Pipelines - VOB/Non-VOB in FHR CRM'),
  ('%Search feature in pipeline%', 'Create Search feature in pipeline section - FHR CRM'),
  ('%Needs Reply%',                'Correct Marker for Needs Reply in Texting - FHR CRM');

-- Every open task she holds, so the report can show what is being LEFT as
-- well as what moves. DD emails are aliases that drift and do not resemble
-- the person, so this keys on the display name and the block below aborts
-- unless it resolves to exactly one user.
create temp table _mechael_open as
select
  u.id            as user_id,
  u.name          as user_name,
  u.email         as user_email,
  t.id            as task_id,
  t.title         as task_title,
  t.status        as task_status,
  t.department_id as from_department
from public.users u
join public.tasks t
  on t.assignee_id = u.id
 and t.status not in ('done', 'rejected')
 and t.archived_at is null
 and t.deleted_at is null
where u.name ~* 'mechael';

-- Just the four. A task already in Facebook is excluded so a re-run is a no-op.
create temp table _mechael_move as
select o.*, g.pattern
  from _mechael_open o
  join _mechael_targets g
    on o.task_title ilike g.pattern
 where o.from_department is distinct from 'dep_facebook';

do $$
declare
  -- ----------------------------------------------------------------------
  -- FLIP THIS TO true TO APPLY. Left false so the first run is a preview.
  -- ----------------------------------------------------------------------
  v_apply   boolean := false;

  v_users   int;
  v_user    text;
  v_matched int;
  v_already int;
  v_dupes   text;
  v_missing text;
  v_tasks   int;
begin
  select count(distinct user_id) into v_users from _mechael_open;
  if v_users <> 1 then
    raise exception
      'Expected exactly one user matching ''mechael'', found %. Tighten the WHERE clause in this file rather than letting it guess.',
      v_users;
  end if;
  select distinct user_id into v_user from _mechael_open;

  -- Only a Facebook member can submit proof on a Facebook task, so without
  -- the membership this would hand her four tasks she cannot close.
  if not exists (
    select 1 from public.department_members
     where user_id = v_user and department_id = 'dep_facebook'
  ) then
    raise exception
      'User % is not a member of dep_facebook. Add them from Leader Console -> People first, then re-run.',
      v_user;
  end if;

  -- A fragment that matched more than one task would move something nobody
  -- asked for. Name the offender; the operator can tighten the fragment.
  select string_agg(format('%s -> %s matches', pattern, n), '; ')
    into v_dupes
    from (select pattern, count(*) as n from _mechael_move group by pattern having count(*) > 1) d;
  if v_dupes is not null then
    raise exception 'These fragments are ambiguous: %. Tighten them before running.', v_dupes;
  end if;

  -- A fragment that matched nothing means the task was renamed, closed or
  -- already moved. Already-in-Facebook is fine on a re-run; anything else is
  -- not, so separate the two before deciding.
  select count(*) into v_already
    from _mechael_open o join _mechael_targets g on o.task_title ilike g.pattern
   where o.from_department = 'dep_facebook';

  select string_agg(g.label, '; ')
    into v_missing
    from _mechael_targets g
   where not exists (select 1 from _mechael_open o where o.task_title ilike g.pattern);
  if v_missing is not null then
    raise exception
      'No open task matches: %. It may have been renamed, completed or archived -- check before running.',
      v_missing;
  end if;

  select count(*) into v_matched from _mechael_move;
  if v_matched + v_already <> 4 then
    raise exception
      'Expected 4 target tasks, resolved % (% already in Facebook). Refusing to run.',
      v_matched + v_already, v_already;
  end if;

  if not v_apply then
    return; -- preview only; the trailing SELECT still reports.
  end if;

  update public.tasks t
     set department_id = 'dep_facebook'
    from _mechael_move m
   where t.id = m.task_id;
  get diagnostics v_tasks = row_count;

  raise notice 'Applied: % task(s) moved to dep_facebook.', v_tasks;
end $$;

-- -----------------------------------------------------------------------------
-- The report. Last statement in the file, because the editor only shows the
-- final result set. Every open task she holds is listed, so "the email task is
-- staying put" is something you can SEE rather than infer. department_now is
-- read back from the task itself: after an apply, exactly the MOVE rows should
-- read dep_facebook, and nothing else should have changed.
-- -----------------------------------------------------------------------------
select
  case when m.task_id is null then 'leave' else 'MOVE' end as action,
  o.task_title,
  o.task_status,
  o.from_department,
  (select t2.department_id from public.tasks t2 where t2.id = o.task_id) as department_now,
  o.task_id,
  o.user_name,
  o.user_email
from _mechael_open o
left join _mechael_move m on m.task_id = o.task_id
order by action, o.task_title;
