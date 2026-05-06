-- One-shot backfill for auth users that pre-date the on_auth_user_created
-- trigger. Idempotent — safe to re-run. After this, every auth.users row
-- with a matching public.users.email will be linked.

update public.users u
   set auth_user_id = a.id
  from auth.users a
 where u.auth_user_id is null
   and a.email is not null
   and lower(u.email) = lower(a.email);
