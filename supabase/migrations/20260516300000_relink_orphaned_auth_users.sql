-- Rescue migration. The previous purge accidentally caught users
-- who had real auth identities linked to seeded mock rows
-- (henry@scaledai.org → u_1, etc.). Those auth.users still exist
-- but their public.users row is gone, so getCurrentUserId returns
-- null and login fails.
--
-- Re-create a public.users row for every auth.users that's currently
-- orphaned (no matching public.users.auth_user_id). Use the same
-- id convention as the on_auth_user_created trigger so the
-- self-healing email fallback in session.ts still works.

insert into public.users (id, name, email, role, auth_user_id)
select
  'u_a_' || substring(replace(au.id::text, '-', ''), 1, 10),
  coalesce(
    nullif(au.raw_user_meta_data ->> 'name', ''),
    initcap(replace(split_part(au.email, '@', 1), '.', ' '))
  ),
  au.email,
  'worker',
  au.id
from auth.users au
where au.email is not null
  and not exists (
    select 1 from public.users u where u.auth_user_id = au.id
  )
on conflict (email) do update
  set auth_user_id = excluded.auth_user_id
  where public.users.auth_user_id is null;
