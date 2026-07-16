-- Department-scoped delegate capability.
--
-- Adds users.delegate_department_ids: a set of department ids that this user
-- may act as a department head WITHIN — assign tasks to any member of, and
-- create tasks in — WITHOUT changing their public `role`. It is the narrower
-- sibling of the is_admin stealth flag (20260520000000_stealth_admin_flag.sql):
--   - is_admin  => full leader power everywhere (all-or-nothing),
--   - delegate  => department-head-style power, but only for the listed
--                  departments, and the person still renders as their real
--                  role (typically "worker" — no crown, no "Department Head").
--
-- The permission gates OR this in: canAssignTaskTo / canCreateTaskInDepartment
-- / canViewDepartmentConsole / canViewTaskScopedToDepartment in src/lib/access.ts
-- (mirrored client-side in src/lib/auth.ts).
--
-- Empty array (the default) = no delegate power, so existing users are
-- unaffected.

alter table public.users
  add column if not exists delegate_department_ids text[] not null default '{}'::text[];

-- Grant: Aaraiz (andrew@scaledai.org) manages the Website department (dep_web)
-- on behalf of its head, Mujtaba (mike@scaledai.org). He stays role='worker'.
-- Idempotent + email-keyed; aborts loudly if the account can't be resolved so a
-- bad email surfaces immediately instead of silently doing nothing.
do $$
declare
  v_user_id text;
begin
  select id into v_user_id
    from public.users
   where email ilike 'andrew@scaledai.org'
   limit 1;
  if v_user_id is null then
    raise exception 'No user with email andrew@scaledai.org found in public.users — confirm the account';
  end if;

  update public.users
     set delegate_department_ids = array['dep_web']
   where id = v_user_id;
end $$;
