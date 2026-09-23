-- Correct the EXECUTE lockdown on the two fb_onboarding security-definer
-- functions. Supersedes the revoke in 20260923130000, which did not work.
--
-- WHY THE EARLIER ONE DIDN'T WORK
--
-- 20260923130000 wrote `revoke all on function ... from public`, copying the
-- pattern used by offboard_user and the three client_health_rpc migrations.
-- That pattern is wrong on Supabase.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, so revoking
-- PUBLIC looks like it should be enough. But Supabase ALSO grants `anon` and
-- `authenticated` EXECUTE *explicitly*, via ALTER DEFAULT PRIVILEGES on the
-- public schema. An explicit grant is not removed by revoking PUBLIC. So after
-- running that migration the grantee list was still:
--
--   {postgres, anon, authenticated, service_role}     -- verified in prod
--
-- i.e. both public roles kept EXECUTE and the function stayed reachable with
-- the anon key that ships in the browser bundle, which is the whole thing the
-- migration existed to prevent.
--
-- The roles have to be named.
--
-- SCOPE
--
-- fb_onboarding_set   — the original gap. Already closed by hand in prod with
--                       the statement below; repeated here so the repo matches
--                       the database and a fresh apply is correct.
-- fb_onboarding_reconcile — added in 20260923120000 with NO grant clause at
--                       all, so it carried the same exposure from the moment
--                       it shipped. Both functions are called only by the
--                       server-side service-role client (src/lib/supabase-admin),
--                       so revoking the public roles changes no app behaviour.
--
-- NOT COVERED HERE, deliberately: offboard_user (destructive — deletes and
-- reassigns a user's data) and recent_inbound_missive_messages (reads client
-- email) carry the same `from public` pattern and are very likely exposed the
-- same way. They are a separate change with a separate blast radius; don't
-- fold them in here just because the fix looks identical.
--
-- Idempotent. Safe to run twice.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

revoke all on function public.fb_onboarding_set(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.fb_onboarding_set(text, text, jsonb)
  to service_role;

revoke all on function public.fb_onboarding_reconcile(text, jsonb, text, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fb_onboarding_reconcile(text, jsonb, text, boolean, timestamptz)
  to service_role;

-- The SQL editor swallows RAISE NOTICE, so verify by selecting.
--
-- Expect exactly two rows, each with grantees = {postgres, service_role}.
-- `postgres` is the owner and stays. If `anon` or `authenticated` appears in
-- either row, the revoke did not take — do not walk away.
select
  p.proname as function_name,
  p.prosecdef as is_definer,
  coalesce(
    array_agg(a.grantee::regrole::text order by a.grantee::regrole::text)
      filter (where a.privilege_type = 'EXECUTE'),
    '{}'
  ) as grantees
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
where n.nspname = 'public'
  and p.proname in ('fb_onboarding_set', 'fb_onboarding_reconcile')
group by p.proname, p.prosecdef
order by p.proname;
