-- =============================================================================
-- Mechael moves onto the Facebook team.
--
-- Two effects, both data-only:
--
--   1. dep_facebook becomes her PRIMARY department. "Primary" is not a column:
--      it is departmentIds[0], and that array is ordered by
--      department_members.created_at (then department_id) in
--      departmentMembershipsByUser() -- src/lib/server-data.ts:104-124. Her
--      Facebook row was backfilled from the department's own creation date
--      (2026-08-26, see 20260901000000_department_members_created_at.sql) while
--      her Software row carries the 2026-05-05 init date, so Software currently
--      wins. Dating the Facebook row one second ahead of her earliest other
--      membership flips it. That is what makes NewTaskForm default new tasks to
--      Facebook (src/components/NewTaskForm.tsx:117-119 picks ownIds[0]).
--
--   2. Her open tasks move to dep_facebook, so they pick up the proof/approval
--      flow, which is gated purely on the TASK's department
--      (src/app/(main)/tasks/[id]/page.tsx:155-158 and the 400 "not a Facebook
--      task" guard in api/tasks/[id]/submit-proof/route.ts:71-72).
--
-- WHAT THIS DOES NOT DO, deliberately:
--   * It does not remove her from dep_software. She keeps visibility of the
--     Software team's work; only the ORDER changes. Drop the membership later
--     from Leader Console -> People if that is wanted -- note that
--     department_members is a permissions grant, not a label.
--   * It does not touch last_activity_at. Re-filing a task is not work on it,
--     and bumping it would reset every "stalled 48h+" badge on the board.
--   * It does not set any task to pending_approval. A Facebook task only gets
--     there when someone submits proof (a photo is required); this migration
--     just makes that route legal for her tasks.
--   * It does not touch done, rejected, archived or deleted tasks. Re-filing
--     finished work would rewrite per-department history and completion counts.
--
-- HOW TO RUN -- PREVIEW FIRST:
--   1. Paste the whole file into the Supabase SQL editor and run it. v_apply is
--      false, so NOTHING is written. Read the result grid at the bottom: it
--      names the person it resolved and every task that would move.
--   2. Only if that grid is right, change `v_apply boolean := false` to `true`
--      and run the file again. It is re-runnable and converges.
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
  v_apply   boolean := false;

  v_users   int;
  v_user    text;
  v_other   timestamptz;
  v_tasks   int;
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
  -- visible and auditable.
  if not exists (
    select 1 from public.department_members
     where user_id = v_user and department_id = 'dep_facebook'
  ) then
    raise exception
      'User % is not a member of dep_facebook yet. Add them from Leader Console -> People first, then re-run.',
      v_user;
  end if;

  if not v_apply then
    return; -- preview only; the trailing SELECT still reports.
  end if;

  -- 1. Make Facebook outrank every other membership she holds. Strictly
  --    earlier rather than equal: a tie falls through to department_id order,
  --    where 'dep_facebook' happens to sort first today, but relying on that
  --    alphabetical accident is exactly the fragility 20260901000000 removed.
  select min(created_at) into v_other
    from public.department_members
   where user_id = v_user
     and department_id <> 'dep_facebook';

  if v_other is not null then
    update public.department_members
       set created_at = v_other - interval '1 second'
     where user_id = v_user
       and department_id = 'dep_facebook'
       and created_at >= v_other;   -- no-op once already primary
  end if;

  -- 2. Move the staged tasks.
  update public.tasks t
     set department_id = 'dep_facebook'
    from _mechael_move m
   where t.id = m.task_id;
  get diagnostics v_tasks = row_count;

  raise notice 'Applied: % task(s) moved to dep_facebook.', v_tasks;
end $$;

-- -----------------------------------------------------------------------------
-- The report. Last statement in the file, because the editor only shows the
-- final result set. primary_department_now is computed with the SAME ordering
-- the app uses, so after an apply it should read dep_facebook -- that is the
-- real confirmation, not the row count.
-- -----------------------------------------------------------------------------
select
  m.user_name,
  m.user_email,
  coalesce(m.task_id, '(no open tasks to move)') as task_id,
  m.task_title,
  m.task_status,
  m.from_department,
  case when m.task_id is null then null else 'dep_facebook' end as to_department,
  (
    select dm.department_id
      from public.department_members dm
     where dm.user_id = m.user_id
     order by dm.created_at, dm.department_id
     limit 1
  ) as primary_department_now
from _mechael_move m
order by m.task_title nulls first;
