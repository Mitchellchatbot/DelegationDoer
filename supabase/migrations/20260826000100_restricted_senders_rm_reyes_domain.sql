-- Restricted senders — R M Reyes Tax Services, company domain.
--
-- DATA ONLY. The tables, indexes and RLS were created by
-- 20260807000000_restricted_senders.sql; this file only inserts a rule into
-- them and touches no schema. Every enforcement site reads the table
-- generically and uncached (src/lib/restricted-senders.ts has no TTL, on
-- purpose), so this takes effect the moment it is applied.
--
-- SECOND HALF OF A PAIR. 20260826000000_restricted_senders_rm_reyes.sql
-- restricted the firm's personal Gmail address with an 'exact' rule. Mitchell
-- then asked for the same treatment Deel got — domain-wide, hide and delete,
-- explicitly including the mail their WordPress install sends
-- (wordpress@rmreyestaxservices.com). Deel is the shape being copied: domain
-- rules, no viewers, plus a one-time residue purge.
--
-- BOTH ROWS ARE REQUIRED; neither subsumes the other:
--
--   rs_rmreyes_gmail  exact   rmreyestaxservices@gmail.com
--   rs_rmreyes_com    domain  rmreyestaxservices.com          <- this file
--
-- The Gmail address is not under rmreyestaxservices.com, so this rule does not
-- cover it. And it can never be expressed as a domain rule: its domain is
-- gmail.com, shared with essentially everyone we correspond with, and a
-- 'domain' row on it would hide a large fraction of the company's real mail
-- from every DelegationDoer user, silently and with no error anywhere. Do not
-- "tidy" the pair into one row. See that migration's header.
--
-- ONE ROW IS ENOUGH for the domain. match_kind 'domain' matches the address's
-- domain OR any subdomain of it, so 'rmreyestaxservices.com' already covers
-- mail.rmreyestaxservices.com, notifications.rmreyestaxservices.com and
-- anything added later. Never a substring test: "contains
-- rmreyestaxservices.com" would also match rmreyestaxservices.com.evil.tld,
-- and "contains rmreyestaxservices" would match notrmreyestaxservices.com.
--
-- NO restricted_sender_viewers ROWS, DELIBERATELY. An empty viewer list is the
-- strongest form of the rule: this mail is hidden from EVERY DelegationDoer
-- user, Mitchell included. It keeps arriving in Microsoft 365 and is read
-- there — DD simply stops surfacing it. (DD has no delete-thread API against
-- the clone, so it could not remove the mail itself even if asked.) Same
-- configuration all five existing rules use.
--
-- Matching is CORRESPONDENT-wide, not sender-only: a thread matches if any
-- participant / last_from, or any message from/to/cc, is at this domain. So
-- our own outbound mail TO anyone there is hidden too, as is a thread that
-- merely cc's them. That is intended — matching only the newest sender would
-- leak a thread whose latest message is our own reply.
--
-- MEASURED BLAST RADIUS at the time of writing, so this is a decision and not
-- a guess. A sweep of every address-bearing column in information_schema found
-- exactly one address at this domain anywhere in DelegationDoer:
-- wordpress@rmreyestaxservices.com, in 6 email_notifications rows across 1
-- thread. The domain is NOT a client (checked clients.contact_emails, website,
-- websites, domain_location), NOT a DD user, and appears in no outbound_lead,
-- client_meeting, scheduled_email or inbox_assignment. Residue is purged by
-- supabase/scripts/20260826_purge_rm_reyes_domain_residue.sql.
--
-- A restricted_senders row only affects inbox reads, the intake pipeline, the
-- notification fan-out and the #email-notifs Slack ping. Client matching,
-- touchpoint tracking, auto-labelling and the composer read public.clients and
-- never consult this table, so they are unaffected.
--
-- Escape hatches, cheapest first — all three are data changes, none needs a
-- deploy:
--   1. insert into public.restricted_sender_viewers (rule_id, user_id)
--      values ('rs_rmreyes_com', '<user id>');  -- give one person access back
--   2. update public.restricted_senders set enabled = false
--       where id = 'rs_rmreyes_com';            -- lift the rule, keep viewers
--   3. delete from public.restricted_senders
--       where id = 'rs_rmreyes_com';            -- remove it entirely
-- If the rule is ever lifted, also remove the mirroring regex in
-- src/lib/email-intake-filters.ts (SENDER_PATTERNS) — that one IS code and
-- would otherwise keep suppressing intake for this domain with no row in this
-- table to explain why.
--
-- created_by is provenance only and does NOT grant access. Resolved from the
-- requesting leader; falls back to null rather than aborting, since a missing
-- user must not stop the restriction itself from landing.

do $$
declare
  v_mitchell text;
begin
  select id into v_mitchell
    from public.users
   where email ilike 'mitchell@scaledai.org'
   limit 1;

  insert into public.restricted_senders (id, pattern, match_kind, label, created_by)
  values
    ('rs_rmreyes_com',
     'rmreyestaxservices.com',
     'domain',
     'R M Reyes Tax Services (company domain)',
     v_mitchell)
  on conflict (id) do nothing;
end $$;

-- Guard: fail the migration loudly if the row did not land as a domain rule on
-- this pattern. `on conflict (id) do nothing` above is what makes
-- re-application safe, but it would also silently accept a pre-existing row
-- someone had created with a different kind or pattern.
--
-- The sibling exact rule is asserted too. These two are only correct as a
-- pair: if rs_rmreyes_gmail has been dropped or rewritten as a domain rule,
-- something has gone wrong that this file must not paper over.
do $$
begin
  if not exists (
    select 1 from public.restricted_senders
     where id = 'rs_rmreyes_com'
       and match_kind = 'domain'
       and lower(pattern) = 'rmreyestaxservices.com'
  ) then
    raise exception
      'rs_rmreyes_com is missing or is not a domain rule on rmreyestaxservices.com';
  end if;

  if not exists (
    select 1 from public.restricted_senders
     where id = 'rs_rmreyes_gmail'
       and match_kind = 'exact'
       and lower(pattern) = 'rmreyestaxservices@gmail.com'
  ) then
    raise exception
      'rs_rmreyes_gmail is missing or is no longer an exact rule — the pair is broken; see 20260826000000_restricted_senders_rm_reyes.sql';
  end if;
end $$;
