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
-- created_at fixes it by construction. Rows that pre-date this column are
-- backfilled from their DEPARTMENT's created_at, not from a single flat
-- sentinel. A membership cannot predate the department it points at, so that is
-- both truthful and the best proxy available -- and it is what makes the result
-- correct rather than merely deterministic: dep_facebook was created
-- 2026-08-26, long after the four originals were seeded in 20260505000000, so
-- Facebook memberships sort AFTER everyone's older ones and can never win the
-- tie-break. Readers order by (created_at, department_id); the tie-break covers
-- departments created in the same statement.
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
-- chip toggle, so the backfilled timestamps on their long-held rows are
-- discarded and all of their memberships get fresh clock_timestamp() values. Order then reflects the
-- order the client sent. That happens to be correct today -- the People tab
-- appends a newly-ticked department to the end of the array -- but it is the
-- client preserving the order, not the schema enforcing it.
--
-- Side effect worth knowing: the four original departments were all created by
-- the same insert in 20260505000000, so they share a created_at. Anyone who
-- already belongs to two or more of THOSE still falls to the department_id
-- tie-break, and their "primary" may settle on a different one of their
-- existing departments than it happened to show before. That order was
-- undefined until now; after this it is fixed and will not drift again.
-- Facebook is unaffected by that tie -- it is strictly newer.
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

-- No ordering tripwire here, deliberately. An earlier revision refused to run
-- if dep_facebook already had members, assuming that could only mean the seed
-- had run first. That was wrong twice over: people can be -- and were -- added
-- to Facebook by hand from Leader Console -> People, and the flat sentinel it
-- was protecting no longer exists. Backfilling from departments.created_at
-- makes the outcome correct whatever order these files run in, because
-- Facebook's memberships are stamped with its own 2026-08-26 creation time,
-- behind every department seeded in 20260505000000.
alter table public.department_members
  add column if not exists created_at timestamptz;

-- DEFAULT first, so any row written from this point forward is stamped
-- correctly even if the backfill below is slow.
alter table public.department_members
  alter column created_at set default clock_timestamp();

-- Backfill from the department's own creation time. A membership cannot predate
-- its department, so this is truthful, and it orders the pre-tracking rows the
-- way reality did: whoever joined an older department outranks a newer one.
-- Crucially it is order-independent -- run this before or after the Facebook
-- seed and Facebook's rows still land at 2026-08-26, behind everything seeded in
-- 20260505000000. departments.created_at is NOT NULL, so every row is covered.
update public.department_members dm
   set created_at = d.created_at
  from public.departments d
 where d.id = dm.department_id
   and dm.created_at is null;

alter table public.department_members
  alter column created_at set not null;

commit;

do $$
declare
  n_rows int;
  n_backfilled int;
  multi text;
begin
  select count(*) into n_rows from public.department_members;
  select count(*) into n_backfilled
    from public.department_members dm
    join public.departments d on d.id = dm.department_id
   where dm.created_at = d.created_at;
  raise notice 'department_members.created_at ready: % row(s), % backfilled from their department''s creation time.',
    n_rows, n_backfilled;

  -- Anyone who already belongs to two or more departments created in the SAME
  -- statement still ties, and falls to the department_id tie-break. Their
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
