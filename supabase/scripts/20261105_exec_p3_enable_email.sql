-- Executive AI Assistant, P3: turn email intelligence on. Step 2 of 2.
--
-- HAND-RUN in the Supabase SQL editor. Never run by the app or by Claude.
--
-- Before running it:
--   1. Apply supabase/migrations/20261105100000_exec_email.sql (its grid all
--      ok), then run 20261105_exec_p3_pin_mail_account.sql. This script
--      refuses to run without the migration or without a pinned mailbox.
--   2. Data terms (L22). The assistant sends his mail, client mail included,
--      to Anthropic for triage. Confirm Anthropic's data terms for this
--      organization cover that before turning it on.
--   3. The shared owner session (L25). Leaders can sign in as Mitchell
--      through owner sign-in links (agreed, #518). The assistant's pages and
--      APIs admit only a password or MFA session (P2b's step-up), so a link
--      session sees none of this. The residual risk: someone who knows his
--      password, or sets a new one during a link session, gets in.
--   4. Legacy intake (L27). If auto-intake is on for his mailbox
--      (public.missive_account_settings.auto_intake_enabled; shown in the
--      grid below), his mail is classified and drafted twice: once by the
--      legacy intake, once by the assistant. P3 doesn't change that setting.
--   5. Restricted senders (L31). Mail that touches a restricted sender is
--      hidden from the assistant entirely. A 'dd_only' restricted policy is
--      not built yet: P3 treats it exactly as 'hidden'.
--
-- Nothing email runs until this is true AND EXEC_ENABLED=true on the app.
--
-- To turn email off again, run the statement at the end of this file (the
-- stored rows stay until they expire; nothing new is read or triaged).

set local lock_timeout = '5s';

create temp table exec_p3_enable_checks (ord int, check_name text, ok boolean, detail text) on commit drop;

do $$
declare
  n_principals int;
  v_principal text;
  v_pin text[];
  v_intake text;
begin
  if not exists (select 1 from pg_attribute
                  where attrelid = to_regclass('public.exec_settings') and attname = 'email_enabled' and not attisdropped) then
    raise exception 'enable aborted, nothing changed: exec_settings.email_enabled does not exist (apply supabase/migrations/20261105100000_exec_email.sql first)';
  end if;

  select count(*) into n_principals
    from public.exec_principals p
    join public.users u on u.id = p.user_id
   where lower(trim(u.email)) = 'mitchell@scaledai.org';
  if n_principals <> 1 then
    raise exception 'enable aborted, nothing changed: expected exactly 1 exec principal for mitchell@scaledai.org, found %', n_principals;
  end if;

  select p.id, p.mail_account_ids into v_principal, v_pin
    from public.exec_principals p
    join public.users u on u.id = p.user_id
   where lower(trim(u.email)) = 'mitchell@scaledai.org';
  if coalesce(cardinality(v_pin), 0) = 0 then
    raise exception 'enable aborted, nothing changed: no mailbox is pinned (run 20261105_exec_p3_pin_mail_account.sql first)';
  end if;
  if not exists (select 1 from public.exec_settings s where s.principal_id = v_principal) then
    raise exception 'enable aborted, nothing changed: the owner has no exec_settings row (re-apply 20261104100000_exec_foundation.sql)';
  end if;

  -- L27: the legacy intake toggle for the pinned mailbox, read-only (the
  -- table belongs to DD's own intake and may not exist everywhere).
  if to_regclass('public.missive_account_settings') is null then
    v_intake := 'missive_account_settings not found';
  else
    execute 'select string_agg(account_id || '': '' || case when auto_intake_enabled then ''ON'' else ''off'' end, '', '')
               from public.missive_account_settings where account_id = any($1)'
      into v_intake using v_pin;
  end if;
  insert into exec_p3_enable_checks values
    (2, 'legacy auto-intake on the pinned mailbox (L27): ON means mail is triaged twice', null, coalesce(v_intake, 'no row: off'));
end $$;

update public.exec_settings s
   set email_enabled = true, updated_at = now()
  from public.exec_principals p
  join public.users u on u.id = p.user_id
 where s.principal_id = p.id
   and lower(trim(u.email)) = 'mitchell@scaledai.org';

insert into exec_p3_enable_checks
select 1, 'email enabled for the owner', s.email_enabled, 'principal ' || p.id || ', pinned ' || array_to_string(p.mail_account_ids, ', ')
  from public.exec_settings s
  join public.exec_principals p on p.id = s.principal_id
  join public.users u on u.id = p.user_id
 where lower(trim(u.email)) = 'mitchell@scaledai.org'
union all
select 3, 'principal enabled', p.enabled, null
  from public.exec_principals p
  join public.users u on u.id = p.user_id
 where lower(trim(u.email)) = 'mitchell@scaledai.org'
union all
select 4, 'restricted policy (dd_only screens as hidden in P3)', null, s.restricted_policy
  from public.exec_settings s
  join public.exec_principals p on p.id = s.principal_id
  join public.users u on u.id = p.user_id
 where lower(trim(u.email)) = 'mitchell@scaledai.org';

select check_name, ok, detail from exec_p3_enable_checks order by ord;

-- ---------------------------------------------------------------------------
-- REVERSE (turn email off). Run on its own:
--
-- update public.exec_settings s
--    set email_enabled = false, updated_at = now()
--   from public.exec_principals p
--   join public.users u on u.id = p.user_id
--  where s.principal_id = p.id
--    and lower(trim(u.email)) = 'mitchell@scaledai.org';
-- ---------------------------------------------------------------------------
