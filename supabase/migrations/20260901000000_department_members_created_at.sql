-- Give department_members a creation timestamp, so a user's departments have a
-- stable, meaningful order.
--
-- WHY THIS IS NEEDED NOW
--
-- Nothing has ever ordered this table, but three loaders turn it into
-- User.departmentIds -- server-data.userDepartmentIds(), server-data.getAllUsers()
-- and /api/users -- and roughly ten call sites treat departmentIds[0] as a
-- person's PRIMARY department:
--
--   * api/tasks POST            - the department a task gets when none is picked
--   * api/sod/create-task       - same, for SOD quick-add
--   * api/incidents             - an even weaker `limit(1)` with no order at all
--   * lib/departments.primaryDepartment() -> Topbar chip, Sidebar ring, page theme
--   * components/SodFlow        - pre-selected department in advanced add
--   * api/client-update/{preview,draft} - which team heading someone's EOD work
--                                 is grouped under in a CLIENT-FACING email
--
-- That was survivable only by luck: every department id created so far sorts
-- AFTER the one people already had. 'dep_facebook' breaks the luck --
--
--     dep_facebook < dep_mkt < dep_seo < dep_software < dep_web
--
-- -- so the moment Postgres serves these rows from the composite primary key
-- (user_id, department_id) rather than a heap scan, Facebook silently becomes
-- the FIRST department of everyone added to it, retagging their new tasks and
-- relabelling their UI. Heap order is not stable either: PATCH /api/users/[id]
-- deletes and reinserts a user's whole membership set on every chip toggle, so
-- the table churns and autovacuum can reuse slots in any order.
--
-- created_at fixes it by construction. Existing rows are stamped with a
-- sentinel that pre-dates every real timestamp, so a membership someone
-- ALREADY HAS always sorts ahead of one they gain later. Readers order by
-- (created_at, department_id): the tie-break makes the order total and stable
-- rather than merely usually-right.
--
-- Note the default is clock_timestamp(), NOT now(). now() is the TRANSACTION
-- timestamp, so every row written by one statement would share it -- and
-- PATCH /api/users/[id] rewrites all of a user's memberships in a single
-- upsert. That would tie every row and hand the order back to the
-- department_id tie-break, i.e. straight back to "Facebook first".
-- clock_timestamp() advances per row, so a multi-row insert preserves the
-- order it was given (the People tab appends a newly-ticked department to the
-- end of the array, which is exactly the behaviour we want).
--
-- Limit of the guarantee, stated so nobody leans on it too hard: PATCH
-- /api/users/[id] deletes and reinserts a user's ENTIRE membership set on every
-- chip toggle, so the sentinel on their long-held rows is discarded and all of
-- their memberships get fresh clock_timestamp() values. Order then reflects the
-- order the client sent. That happens to be correct today -- the People tab
-- appends a newly-ticked department to the end of the array -- but it is the
-- client preserving the order, not the schema enforcing it.
--
-- Side effect worth knowing: users who ALREADY belong to two or more
-- departments all tie on the sentinel and fall to the department_id
-- tie-break, so their "primary" may settle on a different one of their
-- existing departments than it happened to show before. That order was
-- undefined until now; after this it is fixed and will not drift again.
--
-- Purely additive and backwards-compatible -- code that does not select the
-- column is unaffected. SAFE TO APPLY BEFORE the matching code deploys, and it
-- SHOULD be applied first, because the readers order by this column.
--
-- SCOPE, stated plainly so nobody over-trusts this: the ordering is applied in
-- the three loaders that build User.departmentIds --
-- server-data.userDepartmentIds(), server-data.departmentMembershipsByUser()
-- and /api/users. Those cover api/tasks POST, SodFlow and primaryDepartment().
-- They do NOT cover the readers that query department_members directly:
-- api/client-update/{preview,draft}, api/incidents and lib/ai-tools still read
-- it unordered. Those remain as they were -- no better, no worse -- and are
-- tracked as follow-up rather than fixed here.

-- Wrapped in an explicit transaction. Without one, psql autocommits each
-- statement, leaving a window between ADD COLUMN and SET DEFAULT in which the
-- column exists with no default -- and both live membership writers
-- (PATCH /api/users/[id] and POST /api/users/invite) delete and reinsert a
-- user's whole membership set, so a concurrent save would write created_at =
-- NULL and the closing SET NOT NULL would then fail, leaving this half applied.
-- ADD COLUMN takes ACCESS EXCLUSIVE, so inside one transaction nothing else can
-- write. Same shape as 20260512300000_rename_ceo_to_leader.sql.
begin;

-- Tripwire. This file MUST run before the dep_facebook member seed
-- (20260901000200). If the seed went first, its rows are already present and
-- the backfill below would stamp them with the SAME sentinel as everyone's
-- long-held memberships -- every one of the eight would tie, fall to the
-- department_id tie-break, and 'dep_facebook' sorts ahead of every other
-- department id. Facebook would silently become their primary department:
-- retagging new tasks, relabelling the Topbar/Sidebar, and regrouping their EOD
-- work under "Facebook" in a CLIENT-FACING email. Fail loudly instead.
do $$
begin
  if exists (select 1 from public.department_members where department_id = 'dep_facebook') then
    raise exception
      'dep_facebook already has members -- the seed (20260901000200) ran BEFORE this file. Stamping those rows with the pre-existing sentinel would make Facebook everyone''s primary department. Reconcile first: give the dep_facebook rows a created_at of now() by hand, then re-run.';
  end if;
end $$;

alter table public.department_members
  add column if not exists created_at timestamptz;

-- DEFAULT first, so any row written from this point forward is stamped
-- correctly even if the backfill below is slow.
alter table public.department_members
  alter column created_at set default clock_timestamp();

-- Existing memberships pre-date tracking. A fixed sentinel (rather than now())
-- guarantees they sort before every row inserted from here on, even if this
-- migration and a later seed run inside the same transaction.
update public.department_members
   set created_at = timestamptz '2000-01-01 00:00:00+00'
 where created_at is null;

alter table public.department_members
  alter column created_at set not null;

commit;

do $$
declare
  n_rows int;
  n_sentinel int;
  multi text;
begin
  select count(*) into n_rows from public.department_members;
  select count(*) into n_sentinel from public.department_members
   where created_at = timestamptz '2000-01-01 00:00:00+00';
  raise notice 'department_members.created_at ready: % row(s), % stamped as pre-existing.',
    n_rows, n_sentinel;

  -- Everyone who already belongs to more than one department ties on the
  -- sentinel and therefore falls to the department_id tie-break. Their
  -- "primary" department is now FIXED, but it may settle on a different one of
  -- their existing departments than it happened to show before -- which changes
  -- their Topbar chip and, via api/client-update/{preview,draft}, the team
  -- heading their work appears under in a client-facing email. Name them so the
  -- operator can eyeball the list rather than discover it later.
  select string_agg(format('%s (%s)', u.name, x.depts), ', ' order by u.name)
    into multi
    from (
      select dm.user_id, string_agg(dm.department_id, '+' order by dm.department_id) as depts
        from public.department_members dm
       group by dm.user_id
      having count(*) > 1
    ) x
    join public.users u on u.id = x.user_id;

  raise notice 'Users in 2+ departments (primary now pinned by department_id order): %',
    coalesce(multi, '(none)');
end $$;
