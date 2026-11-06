-- Executive AI Assistant, P4: turn assistant drafts on. Step 1 of 2 (send is step 2).
--
-- HAND-RUN in the Supabase SQL editor. Never run by the app or by Claude.
--
-- Before running it:
--   1. The clone (missiveclone) is deployed with CL2 and GET /api/status
--      answers cl2.ready = true; its live tests L0-L14 passed on a test
--      mailbox (CL2 contract §6.3/§6.4).
--   2. MISSIVE_EA_TOKEN is minted with the clone's script
--      (--scopes read,draft --accounts <his pinned account id>), set on the
--      SERVING DD service only, and that service was restarted. The app
--      checks the token against /api/auth/me before every draft operation
--      and turns drafts off when it doesn't match the pin (L4).
--   3. supabase/migrations/20261105200000_exec_drafts.sql is applied and its
--      grid is all ok. This script refuses to run without it.
--   4. Email is on and his mailbox is pinned (the P3 scripts
--      20261105_exec_p3_pin_mail_account.sql and
--      20261105_exec_p3_enable_email.sql). This script refuses otherwise.
--   5. Exactly one enabled principal has a pinned mailbox: the drafting key is
--      bound to one mailbox, and the app fails closed with more (L4).
--   6. Delegate visibility: a draft the assistant saves sits in his Outlook
--      Drafts, where anyone with delegate access to his mailbox can read it.
--
-- What it turns on: generating, editing and saving drafts to Outlook
-- (drafts_enabled). Sending from DD stays OFF (send_enabled stays false):
-- that is 20261105_exec_p4_enable_send.sql, after the live save test.
-- Nothing drafts until this is true AND EXEC_ENABLED=true on the app.
--
-- To turn drafts off again, run the statement at the end of this file
-- (existing rows stay until they expire; nothing new is generated or saved).

set local lock_timeout = '5s';

do $$
declare
  n_principals int;
  v_principal text;
  v_pin text[];
  v_email boolean;
  n_pinned int;
begin
  if not exists (select 1 from pg_attribute
                  where attrelid = to_regclass('public.exec_settings') and attname = 'drafts_enabled' and not attisdropped)
     or to_regclass('public.exec_drafts') is null then
    raise exception 'enable aborted, nothing changed: the P4 drafts migration is missing (apply supabase/migrations/20261105200000_exec_drafts.sql first)';
  end if;

  select count(*) into n_principals
    from public.exec_principals p
    join public.users u on u.id = p.user_id
   where p.enabled and lower(trim(u.email)) = 'mitchell@scaledai.org';
  if n_principals <> 1 then
    raise exception 'enable aborted, nothing changed: expected exactly 1 enabled exec principal for mitchell@scaledai.org, found %', n_principals;
  end if;

  select p.id, p.mail_account_ids into v_principal, v_pin
    from public.exec_principals p
    join public.users u on u.id = p.user_id
   where p.enabled and lower(trim(u.email)) = 'mitchell@scaledai.org';
  if coalesce(cardinality(v_pin), 0) = 0 then
    raise exception 'enable aborted, nothing changed: no mailbox is pinned (run 20261105_exec_p3_pin_mail_account.sql first)';
  end if;

  select s.email_enabled into v_email from public.exec_settings s where s.principal_id = v_principal;
  if v_email is null then
    raise exception 'enable aborted, nothing changed: the owner has no exec_settings row (re-apply 20261104100000_exec_foundation.sql)';
  end if;
  if not v_email then
    raise exception 'enable aborted, nothing changed: email is off (run 20261105_exec_p3_enable_email.sql first)';
  end if;

  -- L4: the drafting key is bound to one mailbox; the app fails closed with more than one pinned principal.
  select count(*) into n_pinned
    from public.exec_principals p
   where p.enabled and coalesce(cardinality(p.mail_account_ids), 0) > 0;
  if n_pinned <> 1 then
    raise exception 'enable aborted, nothing changed: expected exactly 1 enabled principal with a pinned mailbox, found %', n_pinned;
  end if;
end $$;

update public.exec_settings s
   set drafts_enabled = true, updated_at = now()
  from public.exec_principals p
  join public.users u on u.id = p.user_id
 where s.principal_id = p.id
   and p.enabled
   and lower(trim(u.email)) = 'mitchell@scaledai.org';

select p.id as principal_id,
       s.email_enabled,
       s.drafts_enabled,
       s.send_enabled,
       s.voice_enabled,
       coalesce(cardinality(p.mail_account_ids), 0) as pinned_accounts,
       (select count(*)::int from public.exec_principals q
         where q.enabled and coalesce(cardinality(q.mail_account_ids), 0) > 0) as pinned_principals
  from public.exec_settings s
  join public.exec_principals p on p.id = s.principal_id
  join public.users u on u.id = p.user_id
 where p.enabled
   and lower(trim(u.email)) = 'mitchell@scaledai.org';

-- ---------------------------------------------------------------------------
-- REVERSE (turn drafts off; send goes off with them). Run on its own:
--
-- update public.exec_settings s
--    set drafts_enabled = false, send_enabled = false, updated_at = now()
--   from public.exec_principals p
--   join public.users u on u.id = p.user_id
--  where s.principal_id = p.id
--    and lower(trim(u.email)) = 'mitchell@scaledai.org';
-- ---------------------------------------------------------------------------
