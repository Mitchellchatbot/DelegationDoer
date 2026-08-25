-- Restricted senders — R M Reyes Tax Services.
--
-- DATA ONLY. The tables, indexes and RLS were created by
-- 20260807000000_restricted_senders.sql; this file only inserts a rule into
-- them and touches no schema. That is precisely why that migration built a
-- rule TABLE instead of a hardcoded constant: the third restricted
-- correspondent costs one insert, not a deploy. Every enforcement site reads
-- the table generically and uncached (src/lib/restricted-senders.ts has no
-- TTL, on purpose), so this takes effect the moment it is applied.
--
-- Mitchell asked for this address to get the same treatment as Deel and
-- Stripe ("rmreyestaxservices@gmail.com — can u hide this email from DD").
-- It is tax/accounting correspondence landing in mitchell@scaledai.org, the
-- same mailbox the "Boss's mail" inbox_space shares with seven people.
--
-- 'exact', NOT 'domain'. THIS IS THE IMPORTANT LINE IN THIS FILE.
-- The Deel and Stripe rules are domain rules because deel.com and stripe.com
-- are the vendors' own domains. This is a personal Gmail address, and its
-- domain is gmail.com — shared with essentially everyone we correspond with.
-- A 'domain' row here would hide a large fraction of the company's real mail
-- from every DelegationDoer user, silently and with no error anywhere. The
-- unique index is on (lower(pattern), match_kind), so nothing in the schema
-- stops you writing that row; only this comment does. Never put a free-mail
-- provider (gmail.com, outlook.com, yahoo.com, icloud.com, hotmail.com, …) in
-- `pattern` with match_kind 'domain'.
--
-- Corollary: an 'exact' rule covers EXACTLY ONE ADDRESS. If this outfit also
-- writes from a second address, that address needs its own row — there is no
-- pattern that safely generalises from a Gmail address. This is the first
-- 'exact' rule in the table; every prior row is 'domain'. The branch is
-- implemented in addressMatches() (src/lib/restricted-senders.ts) and is a
-- plain string equality after lower-casing.
--
-- NO restricted_sender_viewers ROWS, DELIBERATELY. An empty viewer list is the
-- strongest form of the rule: this mail is hidden from EVERY DelegationDoer
-- user, Mitchell included. It keeps arriving in Microsoft 365 and is read
-- there — DD simply stops surfacing it. (DD has no delete-thread API against
-- the clone, so it could not remove the mail itself even if asked.) Same
-- configuration the Deel and Stripe rules use; see those migrations' headers.
--
-- Matching is CORRESPONDENT-wide, not sender-only: a thread matches if any
-- participant / last_from, or any message from/to/cc, is this address. So our
-- own outbound mail TO this address is hidden too, as is a thread that merely
-- cc's it. That is intended — matching only the newest sender would leak a
-- thread whose latest message is our own reply.
--
-- KNOWN CONSEQUENCE, recorded so it is a decision and not a surprise later:
-- because the match is correspondent-wide and the viewer list is empty, if
-- anyone at Scaled AI needs to send to or read from this address they must do
-- it in Outlook, not DD — and DD's client touchpoint tracking will not see
-- those exchanges. Escape hatches, cheapest first — all three are data
-- changes, none needs a deploy:
--   1. insert into public.restricted_sender_viewers (rule_id, user_id)
--      values ('rs_rmreyes_gmail', '<user id>');  -- give one person access back
--   2. update public.restricted_senders set enabled = false
--       where id = 'rs_rmreyes_gmail';            -- lift the rule, keep viewers
--   3. delete from public.restricted_senders
--       where id = 'rs_rmreyes_gmail';            -- remove it entirely
-- If the rule is ever lifted, also remove the mirroring regex in
-- src/lib/email-intake-filters.ts (SENDER_PATTERNS) — that one IS code and
-- would otherwise keep suppressing intake for this sender with no row in this
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
    ('rs_rmreyes_gmail',
     'rmreyestaxservices@gmail.com',
     'exact',
     'R M Reyes Tax Services (individual sender)',
     v_mitchell)
  on conflict (id) do nothing;
end $$;

-- Guard: fail the migration loudly if the row did not land with match_kind
-- 'exact'. `on conflict (id) do nothing` above is what makes re-application
-- safe, but it would also silently accept a pre-existing row someone had
-- created as 'domain' — the one mistake this file exists to prevent.
do $$
begin
  if not exists (
    select 1 from public.restricted_senders
     where id = 'rs_rmreyes_gmail'
       and match_kind = 'exact'
       and lower(pattern) = 'rmreyestaxservices@gmail.com'
  ) then
    raise exception
      'rs_rmreyes_gmail is missing or is not an exact-match rule on rmreyestaxservices@gmail.com';
  end if;
end $$;
