-- DESTRUCTIVE: signs the owner (mitchell@scaledai.org) out on EVERY device.
-- Run deliberately, by a person, in the Supabase SQL editor:
--
--   1. once after the P0.3 deploy (closes any owner session minted through the
--      old leader magic-link path — see 20261104_p0_owner_session_audit.sql),
--   2. again right before EXEC_ENABLED=true for the executive assistant.
--
-- Tell Mitchell first: he will have to sign in again everywhere (web + desktop
-- widget). DD's middleware calls getUser(), which rejects an access token as
-- soon as its session row is gone, and every refresh fails. (A raw access JWT
-- stays signature-valid until it expires — Supabase default 1 hour — but after
-- the P0.1 lockdown the `authenticated` role can't read any table with it.)
--
-- If 20261104_p0_owner_session_audit.sql showed a REDEEMED claim minted by
-- someone else, also have the owner reset his password and check the MFA /
-- identity / email-change rows that script lists: those survive this script.
--
-- Also marks any unredeemed owner sign-in claims as used, so a link someone
-- else minted earlier can never be redeemed (the app now refuses them anyway).
--
-- Guarded: aborts unless exactly one auth user has the owner's email. The
-- editor runs the script as one transaction, so an abort changes nothing.

do $$
declare
  n int;
begin
  select count(*) into n from auth.users where lower(email) = 'mitchell@scaledai.org';
  if n <> 1 then
    raise exception 'expected exactly 1 auth user for mitchell@scaledai.org, found %', n;
  end if;
end $$;

-- Refresh tokens hang off sessions (ON DELETE CASCADE in GoTrue's schema); the
-- explicit delete also covers any token row without a session.
delete from auth.refresh_tokens
where user_id = (select id::text from auth.users where lower(email) = 'mitchell@scaledai.org');

delete from auth.sessions
where user_id = (select id from auth.users where lower(email) = 'mitchell@scaledai.org');

update public.magic_link_claims
set used_at = now()
where lower(trim(email)) = 'mitchell@scaledai.org'
  and used_at is null;

-- Result grid (the editor shows only the last statement's rows): both counts
-- should be 0.
select
  (select count(*) from auth.sessions
     where user_id = (select id from auth.users where lower(email) = 'mitchell@scaledai.org'))       as remaining_sessions,
  (select count(*) from public.magic_link_claims
     where lower(trim(email)) = 'mitchell@scaledai.org' and used_at is null)                          as unredeemed_owner_claims;
