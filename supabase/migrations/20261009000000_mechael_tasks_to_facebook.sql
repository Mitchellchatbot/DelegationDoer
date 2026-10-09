-- =============================================================================
-- Re-file Mechael's open tasks into the Facebook department.
--
-- The department is not a label on these: the proof/approval flow is gated
-- purely on the TASK's department (isFb in src/app/(main)/tasks/[id]/page.tsx,
-- and the 400 "not a Facebook task" guard in
-- api/tasks/[id]/submit-proof/route.ts). Moving them is what turns sign-off on.
--
-- SCOPE -- this file does ONE thing. Two earlier ideas were dropped once the
-- New-task department picker landed, and both are deliberately absent:
--   * It does NOT change her primary department. With the picker she chooses
--     per task, so the default only decides which option is pre-selected --
--     and departmentIds[0] also drives her Topbar chip, her sidebar ring and
--     the board's default filter. Leave it on Software; nothing needs it.
--   * It does NOT pin a Slack channel. Announcements fire at creation, the
--     claim path needs an unassigned task, and the inactivity digest only
--     covers unassigned team tasks -- so re-filing already-created, already-
--     assigned tasks posts NOTHING. There is no announcement to redirect.
--
-- Also deliberately untouched:
--   * last_activity_at. Re-filing a task is not work on it, and bumping it
--     would reset every "stalled 48h+" badge -- three of these are stalled,
--     which is information worth keeping.
--   * done / rejected / archived / deleted tasks, so per-department history
--     and completion counts are not rewritten.
--
-- HOW TO RUN -- PREVIEW FIRST:
--   1. Paste the whole file into the Supabase SQL editor and run it. v_apply
--      is false, so NOTHING is written. Read the result grid at the bottom:
--      it names the person it resolved and every task that would move.
--   2. Only if that list is right, change `v_apply boolean := false` to
--      `true` and run the file again. Re-runnable; it converges.
--
-- Expected list as of 2026-10-09 (4 open tasks, all assigned to her):
--   Setup formreactor for Arrow Passsage
--   Create Two Pipelines - VOB/Non-VOB in FHR CRM
--   Create Search feature in pipeline section - FHR CRM
--   Correct Marker for 'Needs Reply' in Texting - FHR CRM
-- If the grid shows more or fewer than that, stop and look before applying.
--
-- RAISE NOTICE is invisible in the Supabase SQL editor, so the report below is
-- a plain trailing SELECT and anything genuinely dangerous is an exception.
-- =============================================================================

-- Top-of-file drop, not a trailing one: a trailing drop would hide the report,
-- and this makes a re-run after an aborted attempt clean.
drop table if exists _mechael_move;

-- -----------------------------------------------------------------------------
-- Stage the targets. DD emails are aliases that drift and do not resemble the
-- person, so this keys on the display name and refuses to guess -- the block
-- below aborts unless the name resolves to exactly one user. The report prints
-- the resolved name AND email so the operator can confirm it is the right
-- Mechael before applying.
-- -----------------------------------------------------------------------------
create temp table _mechael_move as
select
  u.id            as user_id,
  u.name          as user_name,
  u.email         as user_email,
  t.id            as task_id,
  t.title         as task_title,
  t.status        as task_status,
  t.department_id as from_department
from public.users u
left join public.tasks t
  on t.assignee_id = u.id
 and t.department_id is distinct from 'dep_facebook'
 and t.status not in ('done', 'rejected')
 and t.archived_at is null
 and t.deleted_at is null
where u.name ~* 'mechael';

do $$
declare
  -- ----------------------------------------------------------------------
  -- FLIP THIS TO true TO APPLY. Left false so the first run is a preview.
  -- ----------------------------------------------------------------------
  v_apply  boolean := false;

  v_users  int;
  v_user   text;
  v_tasks  int;
begin
  select count(distinct user_id) into v_users from _mechael_move;
  if v_users <> 1 then
    raise exception
      'Expected exactly one user matching ''mechael'', found %. Tighten the WHERE clause in this file rather than letting it guess.',
      v_users;
  end if;

  select distinct user_id into v_user from _mechael_move;

  -- Membership is a prerequisite, not something this file invents: granting a
  -- department is a permissions change and belongs in the UI, where it is
  -- visible and auditable. It also matters for what happens next -- only a
  -- Facebook member can submit proof on a Facebook task, so without this the
  -- move would hand her tasks she cannot complete.
  if not exists (
    select 1 from public.department_members
     where user_id = v_user and department_id = 'dep_facebook'
  ) then
    raise exception
      'User % is not a member of dep_facebook. Add them from Leader Console -> People first, then re-run.',
      v_user;
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
-- final result set. department_now is read back from the task itself, so after
-- an apply every row should read dep_facebook -- that is the confirmation,
-- not the row count.
-- -----------------------------------------------------------------------------
select
  m.user_name,
  m.user_email,
  coalesce(m.task_id, '(no open tasks to move)') as task_id,
  m.task_title,
  m.task_status,
  m.from_department,
  (select t2.department_id from public.tasks t2 where t2.id = m.task_id) as department_now
from _mechael_move m
order by m.task_title nulls first;
