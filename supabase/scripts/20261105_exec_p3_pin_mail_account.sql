-- Executive AI Assistant, P3: pin the owner's mailbox. Step 1 of 2 to turn email on.
--
-- HAND-RUN in the Supabase SQL editor. Never run by the app or by Claude.
-- Running this does NOT turn email on: that is
-- 20261105_exec_p3_enable_email.sql, run after this one.
--
-- What it does: sets exec_principals.mail_account_ids for the owner
-- (mitchell@scaledai.org) to exactly one clone mailbox, the row of
-- missive.email_accounts with the same address and provider = 'microsoft'
-- (the Graph connection: an IMAP duplicate, provider NULL, carries none of
-- the Outlook signals the assistant reads). The pin is the assistant's only
-- guard on which mail it may read (contract L29), so it is never guessed.
--
-- It aborts, changing nothing, unless it finds exactly one owner principal
-- and exactly one such mailbox.
--
-- !! missive.email_accounts holds mailbox passwords and OAuth tokens. This
-- !! script reads NAMED COLUMNS ONLY (id, email, provider, display_name,
-- !! last_synced_at). Never `select *` from that table, here or anywhere.
--
-- Needs the P2a foundation (exec_principals). Idempotent: running it again
-- pins the same mailbox again. The grid at the end shows the pin before and
-- after.

set local lock_timeout = '5s';

do $$
declare
  n_principals int;
  n_accounts int;
begin
  if to_regclass('public.exec_principals') is null then
    raise exception 'pin aborted, nothing changed: public.exec_principals does not exist (apply 20261104100000_exec_foundation.sql first)';
  end if;
  if to_regclass('missive.email_accounts') is null then
    raise exception 'pin aborted, nothing changed: missive.email_accounts does not exist (the clone''s schema must be in this project)';
  end if;

  select count(*) into n_principals
    from public.exec_principals p
    join public.users u on u.id = p.user_id
   where lower(trim(u.email)) = 'mitchell@scaledai.org';
  if n_principals <> 1 then
    raise exception 'pin aborted, nothing changed: expected exactly 1 exec principal for mitchell@scaledai.org, found %', n_principals;
  end if;

  select count(*) into n_accounts
    from missive.email_accounts a
   where lower(trim(a.email)) = 'mitchell@scaledai.org'
     and a.provider = 'microsoft';
  if n_accounts <> 1 then
    raise exception 'pin aborted, nothing changed: expected exactly 1 microsoft mailbox for mitchell@scaledai.org in missive.email_accounts, found %', n_accounts;
  end if;
end $$;

-- Pin it, and show the result (the SQL editor shows only this last grid).
with target as (
  select p.id as principal_id, p.mail_account_ids as previous_mail_account_ids, a.id as account_id
    from public.exec_principals p
    join public.users u on u.id = p.user_id
    join missive.email_accounts a
      on lower(trim(a.email)) = 'mitchell@scaledai.org' and a.provider = 'microsoft'
   where lower(trim(u.email)) = 'mitchell@scaledai.org'
), pinned as (
  update public.exec_principals p
     set mail_account_ids = array[t.account_id], updated_at = now()
    from target t
   where p.id = t.principal_id
  returning p.id, p.enabled, p.mail_account_ids
)
select pn.id as principal_id,
       pn.enabled as principal_enabled,
       t.previous_mail_account_ids,
       pn.mail_account_ids,
       a.email as account_email,
       a.provider as account_provider,
       a.display_name as account_display_name,
       case when a.last_synced_at is null then null else to_timestamp(a.last_synced_at / 1000.0) end as account_last_synced_at
  from pinned pn
  join target t on t.principal_id = pn.id
  join missive.email_accounts a on a.id = t.account_id;
