-- Purge the demo-seed users that were planted in the original init
-- migration. Real signed-up users have auth.uid UUIDs; the mock
-- seed used `u_<digit>` ids. Filter on that pattern so we can
-- never delete a real account by accident.
--
-- Order matters because tasks.creator_id has an ON DELETE RESTRICT
-- foreign key. Clear out anything pointing at mock users *before*
-- deleting the users themselves.

-- 1) Tasks created by or assigned to a mock user — delete entirely.
--    Real tasks couldn't reference these users (they're not visible
--    in any picker), so this only catches mock seed data.
delete from public.tasks
 where (creator_id  ~ '^u_[0-9]+$')
    or (assignee_id ~ '^u_[0-9]+$');

-- 2) Mock seed projects (`p_<digit>$`).
delete from public.projects
 where id ~ '^p_[0-9]+$';

-- 3) Department memberships for mock users.
delete from public.department_members
 where user_id ~ '^u_[0-9]+$';

-- 4) Activity logs / kudos / skill profiles tied to mock users.
--    Most of these have CASCADE but be explicit for the ones that
--    don't.
delete from public.activity_logs
 where user_id ~ '^u_[0-9]+$';

delete from public.kudos
 where from_user_id ~ '^u_[0-9]+$'
    or to_user_id   ~ '^u_[0-9]+$';

-- 5) Finally the users themselves.
delete from public.users
 where id ~ '^u_[0-9]+$';
