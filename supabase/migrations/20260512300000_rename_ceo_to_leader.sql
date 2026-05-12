-- Rename the "ceo" role to "leader" everywhere.
--
-- The original schema declared role as a Postgres ENUM, which makes
-- renaming a value awkward (you can ADD VALUE but not remove one, and
-- renaming requires an ALTER TYPE in a separate transaction). The
-- cleanest path is to convert the column to TEXT with a CHECK
-- constraint — same set of valid values, but trivially editable
-- forever. Then we migrate the data.
--
-- This is a one-way rename: any code path still referring to "ceo"
-- after this migration will fail the check constraint.

begin;

-- 1) Drop the dependent default + cast the column to text so we can
--    drop the enum type cleanly.
alter table users alter column role drop default;
alter table users alter column role type text using role::text;

-- 2) Rename existing 'ceo' rows to 'leader' before tightening the
--    check constraint.
update users set role = 'leader' where role = 'ceo';

-- 3) Reapply default + check constraint with the new value set.
alter table users alter column role set default 'worker';
alter table users add constraint users_role_check
  check (role in ('leader', 'department_head', 'worker'));

-- 4) Drop the old enum type now that nothing references it.
drop type if exists role;

commit;
