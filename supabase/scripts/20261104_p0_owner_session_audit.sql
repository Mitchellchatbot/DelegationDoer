-- READ-ONLY. Safe to run in the Supabase SQL editor at any time.
--
-- Until this PR, any leader or stealth admin could mint a sign-in link for the
-- owner (POST /api/users/<id>/magic-link) and the response returned the link to
-- the caller. Someone holding such a session could also have called Supabase
-- Auth directly to change the password, add an MFA factor or start an email
-- change — changes that SURVIVE signing the owner out. This lists, in one
-- result grid:
--
--   claim minted by someone else  owner sign-in claims not created by the owner
--                                 (used_at set = it was redeemed)
--   live auth session             every current session for the owner
--   auth account state            pending email/phone change, last sign-in,
--                                 password/confirmation timestamps
--   linked identity               every identity (provider) on the account
--   mfa factor                    every MFA factor on the account
--   auth audit event              the owner's Auth audit-log events, last 180
--                                 days, minus routine token refreshes (empty if
--                                 the project doesn't keep audit rows in the DB)
--
-- Columns whose names look like secrets (token, key, secret, hash, password,
-- hmac) are stripped from every detail blob before display.
--
-- WHAT TO DO WITH IT
--   * Any "claim minted by someone else" with used_at set means a session was
--     created for the owner by someone else: run
--     20261104_p0_revoke_owner_sessions.sql AND have the owner reset his
--     password, then review the identity/MFA/email-change rows below.
--   * An MFA factor, identity or pending email change the owner doesn't
--     recognise: remove it in Supabase Dashboard → Authentication → Users.

with owner_auth as (
  select u.id
  from auth.users u
  where lower(u.email) = 'mitchell@scaledai.org'
)
select kind, at, detail
from (
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
  select 'live auth session', s.created_at,
         (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(s)) e(k, v)
           where k !~* '(token|key|secret|hash|password|hmac)')
  from auth.sessions s
  where s.user_id in (select id from owner_auth)

  union all
  select 'auth account state', u.updated_at,
         (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(u)) e(k, v)
           where k !~* '(token|key|secret|hash|password|hmac)'
             and k in ('id', 'email', 'email_change', 'email_change_sent_at', 'phone', 'phone_change',
                       'email_confirmed_at', 'last_sign_in_at', 'recovery_sent_at', 'updated_at',
                       'created_at', 'banned_until', 'is_sso_user'))
  from auth.users u
  where u.id in (select id from owner_auth)

  union all
  select 'linked identity', i.created_at,
         (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(i)) e(k, v)
           where k !~* '(token|key|secret|hash|password|hmac)')
  from auth.identities i
  where i.user_id in (select id from owner_auth)

  union all
  select 'mfa factor', f.created_at,
         (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(f)) e(k, v)
           where k !~* '(token|key|secret|hash|password|hmac)')
  from auth.mfa_factors f
  where f.user_id in (select id from owner_auth)

  union all
  select 'auth audit event', a.created_at,
         jsonb_build_object(
           'action',   a.payload ->> 'action',
           'actor',    a.payload ->> 'actor_username',
           'traits',   a.payload -> 'traits',
           'ip',       a.ip_address
         )
  from auth.audit_log_entries a
  where a.created_at > now() - interval '180 days'
    and (a.payload ->> 'actor_id') in (select id::text from owner_auth)
    and coalesce(a.payload ->> 'action', '') not in ('token_refreshed', 'token_revoked')
) x
order by at desc nulls last;
