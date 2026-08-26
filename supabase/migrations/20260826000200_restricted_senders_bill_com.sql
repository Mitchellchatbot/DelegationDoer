-- Restricted senders — Bill.com.
--
-- DATA ONLY. The tables, indexes and RLS were created by
-- 20260807000000_restricted_senders.sql; this file only inserts a rule into
-- them and touches no schema. Every enforcement site reads the table
-- generically and uncached (src/lib/restricted-senders.ts has no TTL, on
-- purpose), so this takes effect the moment it is applied.
--
-- WHY. The R M Reyes rules (20260826000000, 20260826000100) hide that firm's
-- own mail, but their INVOICES do not come from them — they arrive via
-- Bill.com, so no rule on the firm can reach them. Mitchell was told that
-- restricting the platform means restricting every vendor routed through it,
-- and asked for it anyway: "lets do it, hide all bill.com invoices from DD."
--
-- ONE ROW IS ENOUGH. match_kind 'domain' matches the address's domain OR any
-- subdomain of it, so 'bill.com' covers both senders actually observed —
-- account-services@inform.bill.com and account-services@legal.bill.com — plus
-- anything Bill.com adds later. Contrast Deel, which needed two rows only
-- because deel.support is a separate registrable domain rather than a
-- subdomain of deel.com. Never a substring test: "contains bill.com" would
-- also match bill.com.evil.tld, and "contains bill" would match
-- notbill.com and mybill.com. `bill` is a common word — this matters more
-- here than it did for deel or stripe.
--
-- NO restricted_sender_viewers ROWS, DELIBERATELY. An empty viewer list is the
-- strongest form of the rule: this mail is hidden from EVERY DelegationDoer
-- user, Mitchell included. It keeps arriving in Microsoft 365 and is read
-- there — DD simply stops surfacing it. Same configuration all six existing
-- rules use.
--
-- Matching is CORRESPONDENT-wide, not sender-only: a thread matches if any
-- participant / last_from, or any message from/to/cc, is at this domain. So
-- our own outbound mail TO Bill.com is hidden too, as is a thread that merely
-- cc's them.
--
--
-- KNOWN OVER-MATCH — the important paragraph in this file.
--
-- Bill.com is a shared AP/AR PLATFORM, not a counterparty. Unlike Deel and
-- Stripe, whose domains identify one vendor we deal with, this rule hides mail
-- ABOUT every vendor and every customer routed through the platform, not just
-- the one that prompted it. The sender address is the same for all of them
-- (account-services@), so there is no way to tell them apart at the rule
-- layer.
--
-- Today that costs nothing, and this was measured rather than assumed: of the
-- 12 Bill.com emails in DelegationDoer at the time of writing, 11 are R M
-- Reyes invoices and payment confirmations and the 12th is an account notice
-- ("Autopay is turned on for Scale AI"). There is no other vendor's Bill.com
-- mail to lose. Nobody at @bill.com is a human correspondent — every observed
-- sender is account-services@.
--
-- The cost is PROSPECTIVE, and it is real: IF SCALED AI EVER INVOICES CLIENTS
-- THROUGH BILL.COM, those "payment received" / "invoice due" / "autopay"
-- notices will be hidden from everyone, silently, with nothing in the app to
-- say why. Whoever turns that on needs to know this rule exists. That is the
-- whole reason this paragraph is here.
--
-- Escape hatches, cheapest first — all three are data changes, none needs a
-- deploy:
--   1. insert into public.restricted_sender_viewers (rule_id, user_id)
--      values ('rs_bill_com', '<user id>');   -- give one person access back
--   2. update public.restricted_senders set enabled = false
--       where id = 'rs_bill_com';             -- lift the rule, keep viewers
--   3. REPLACE IT WITH SOMETHING NARROWER. This is the natural retreat if
--      client billing ever moves onto Bill.com: drop this row and insert
--      match_kind 'domain' on 'inform.bill.com' alone (vendor invoice
--      notifications), or match_kind 'exact' rows on the specific
--      account-services@ addresses that are noisy. Both leave the rest of
--      Bill.com visible.
-- If the rule is ever lifted, also remove the mirroring regex in
-- src/lib/email-intake-filters.ts (SENDER_PATTERNS) — that one IS code and
-- would otherwise keep suppressing intake for this domain with no row in this
-- table to explain why.
--
-- Residue from mail that already arrived is purged by
-- supabase/scripts/20260826_purge_bill_com_residue.sql. Measured before
-- writing: 9 threads, 12 notifications, 9 routing_decisions, 5
-- thread_read_state, and ZERO tasks and ZERO email_drafts — so nothing a
-- person wrote or worked is at stake. bill.com is not a client, not a DD
-- user, and appears in no outbound_lead, client_meeting, scheduled_email or
-- inbox_assignment (verified by a sweep of every address-bearing column in
-- information_schema).
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
    ('rs_bill_com',
     'bill.com',
     'domain',
     'Bill.com (AP/AR platform)',
     v_mitchell)
  on conflict (id) do nothing;
end $$;

-- Guard: fail the migration loudly if the row did not land as a domain rule on
-- this pattern. `on conflict (id) do nothing` above is what makes
-- re-application safe, but it would also silently accept a pre-existing row
-- someone had created with a different kind or pattern.
do $$
begin
  if not exists (
    select 1 from public.restricted_senders
     where id = 'rs_bill_com'
       and match_kind = 'domain'
       and lower(pattern) = 'bill.com'
  ) then
    raise exception
      'rs_bill_com is missing or is not a domain rule on bill.com';
  end if;
end $$;
