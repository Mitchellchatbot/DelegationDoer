-- Executive AI Assistant, P4: turn sending from DD on. Step 2 of 2.
--
-- HAND-RUN in the Supabase SQL editor. Never run by the app or by Claude.
--
-- Before running it:
--   1. Drafts are on (20261105_exec_p4_enable_drafts.sql ran, its grid shows
--      drafts_enabled = true). This script refuses otherwise.
--   2. The live save test is done through DD's own Save (L23 step 5): a reply
--      draft generated in DD and saved to Outlook was seen in his Outlook
--      Drafts; its inline images, a single signature (no duplicate) and the
--      quoted "Sent:" timezone were checked; then it was deleted.
--   3. The clone's EA_SEND_ENABLED is set to his account id and the clone was
--      restarted: GET /api/auth/me with MISSIVE_EA_TOKEN answers
--      auth.sendEnabled = true, and GET /api/status answers cl2.send not "off".
--   4. MISSIVE_EA_SEND_TOKEN is minted with the clone's script
--      (--scopes send --accounts <his account id>), set on the SERVING DD
--      service only, and that service was restarted. The app checks its
--      claims before every send and refuses when they don't match the pin.
--   5. The first real send is planned with Mitchell (L23 step 6): a reply to
--      an internal teammate's thread, at a time he chooses.
--
-- What it turns on: "Review & send" in DD for a saved Outlook draft
-- (send_enabled). Every send still needs the review, the explicit confirm and
-- the checks above at request time; this switch alone sends nothing.
--
-- To turn sending off again, run the statement at the end of this file.

set local lock_timeout = '5s';

do $$
declare
  n_principals int;
  v_principal text;
  v_pin text[];
  v_email boolean;
  v_drafts boolean;
  n_pinned int;
begin
  if not exists (select 1 from pg_attribute
                  where attrelid = to_regclass('public.exec_settings') and attname = 'send_enabled' and not attisdropped)
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

  select s.email_enabled, s.drafts_enabled into v_email, v_drafts
    from public.exec_settings s where s.principal_id = v_principal;
  if v_email is null then
    raise exception 'enable aborted, nothing changed: the owner has no exec_settings row (re-apply 20261104100000_exec_foundation.sql)';
  end if;
  if not v_email then
    raise exception 'enable aborted, nothing changed: email is off (run 20261105_exec_p3_enable_email.sql first)';
  end if;
  if not v_drafts then
    raise exception 'enable aborted, nothing changed: drafts are off (run 20261105_exec_p4_enable_drafts.sql first)';
  end if;

  select count(*) into n_pinned
    from public.exec_principals p
   where p.enabled and coalesce(cardinality(p.mail_account_ids), 0) > 0;
  if n_pinned <> 1 then
    raise exception 'enable aborted, nothing changed: expected exactly 1 enabled principal with a pinned mailbox, found %', n_pinned;
  end if;
end $$;

update public.exec_settings s
   set send_enabled = true, updated_at = now()
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
-- REVERSE (turn sending off; drafts stay on). Run on its own:
--
-- update public.exec_settings s
--    set send_enabled = false, updated_at = now()
--   from public.exec_principals p
--   join public.users u on u.id = p.user_id
--  where s.principal_id = p.id
--    and lower(trim(u.email)) = 'mitchell@scaledai.org';
-- ---------------------------------------------------------------------------
