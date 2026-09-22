-- Lock fb_onboarding_set() down to the service role.
--
-- THE GAP
--
-- fb_onboarding_set() is `security definer`, so it runs as its owner and
-- bypasses RLS by design — that is what lets the app merge one checklist key
-- atomically while fb_onboarding itself has RLS on with zero policies.
--
-- But it was created without a grant, and Postgres grants EXECUTE on a new
-- function to PUBLIC by default. In Supabase, `anon` and `authenticated` both
-- inherit PUBLIC and both have USAGE on the `public` schema, and PostgREST
-- exposes every function in that schema as an RPC endpoint. So anyone holding
-- the project's anon key — which ships in the browser bundle, it is not a
-- secret — can POST /rest/v1/rpc/fb_onboarding_set with any task id and any
-- jsonb, and write straight into that onboarding's `state`.
--
-- That bypasses BOTH gates the feature relies on: the table's RLS (definer
-- rights) and the route's gate() permission check (never invoked). It also
-- bypasses normaliseValue(), so the value written need not be a registered
-- key or even the { v, by, at } shape the readers expect.
--
-- Pre-existing since the function was created in 20260921100000; nothing in
-- the stage work introduced or widened it.
--
-- THE FIX
--
-- Exactly what the four other security-definer functions in this repo already
-- do — see 20260731000000_offboard_user.sql and the three client_health_rpc
-- migrations. Nothing in the app changes: every caller is the server-side
-- service-role client (src/lib/supabase-admin.ts), which is unaffected by a
-- PUBLIC revoke.
--
-- APPLY THIS ON ITS OWN, not bundled with a feature migration. It is the one
-- statement here that can break saving if the signature is mistyped: a revoke
-- against a signature that does not exist errors loudly (good), but a revoke
-- that lands while a grant to service_role does not would make every checklist
-- tick fail. Run the verification select at the bottom before walking away.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

revoke all on function public.fb_onboarding_set(text, text, jsonb) from public;
grant execute on function public.fb_onboarding_set(text, text, jsonb) to service_role;

-- The SQL editor swallows RAISE NOTICE, so verify by selecting.
--
-- Expect exactly one row, with:
--   grantees = {service_role}   (NOT containing anon, authenticated or PUBLIC)
--   is_definer = true           (unchanged — we did not touch the body)
select
  p.proname                                          as function_name,
  p.prosecdef                                        as is_definer,
  coalesce(
    array_agg(a.grantee::regrole::text order by a.grantee::regrole::text)
      filter (where a.privilege_type = 'EXECUTE'),
    '{}'
  )                                                  as grantees
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
where n.nspname = 'public'
  and p.proname = 'fb_onboarding_set'
group by p.proname, p.prosecdef;
