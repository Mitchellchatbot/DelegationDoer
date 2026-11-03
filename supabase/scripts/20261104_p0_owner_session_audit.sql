-- READ-ONLY. Safe to run in the Supabase SQL editor at any time.
--
-- Until this PR, any leader or stealth admin could mint a sign-in link for the
-- owner (POST /api/users/<id>/magic-link) and the response returned the link to
-- the caller. This lists, in one result grid:
--
--   * every sign-in claim for the owner that someone OTHER than the owner
--     created (used_at set = it was redeemed, i.e. a session was minted), and
--   * every live Supabase Auth session for the owner, with the user agent /
--     IP / timestamps GoTrue stored for it.
--
-- Anything unexpected here means an owner session may exist that the owner
-- didn't start. Follow up with 20261104_p0_revoke_owner_sessions.sql.

select 'claim minted by someone else' as kind,
       c.created_at                    as at,
       jsonb_build_object(
         'claim_id',          c.id,
         'created_by',        c.created_by,
         'created_by_email',  cu.email,
         'created_by_name',   cu.name,
         'used_at',           c.used_at,
         'expires_at',        c.expires_at
       )                               as detail
from public.magic_link_claims c
left join public.users cu on cu.id = c.created_by
where lower(trim(c.email)) = 'mitchell@scaledai.org'
  and (cu.email is null or lower(trim(cu.email)) <> 'mitchell@scaledai.org')

union all

select 'live auth session' as kind,
       s.created_at        as at,
       to_jsonb(s)         as detail
from auth.sessions s
where s.user_id in (select u.id from auth.users u where lower(u.email) = 'mitchell@scaledai.org')

order by at desc;
