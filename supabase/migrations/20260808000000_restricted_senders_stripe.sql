-- Restricted senders — Stripe.
--
-- DATA ONLY. The tables, indexes and RLS were created by
-- 20260807000000_restricted_senders.sql; this file only inserts rules into
-- them and touches no schema. That is precisely why that migration built a
-- rule TABLE instead of a hardcoded constant: the second vendor costs one
-- insert, not a deploy. Every enforcement site reads the table generically
-- and uncached (src/lib/restricted-senders.ts has no TTL, on purpose), so
-- this takes effect the moment it is applied.
--
-- Mitchell asked for Stripe to get the same treatment as Deel ("Can u remove
-- stripe emails from going to Delegation Doer"). Stripe is payment/billing
-- traffic — receipts, payouts, failed charges, disputes, invoices — landing in
-- the same mailbox the "Boss's mail" inbox_space shares with seven people.
--
-- NO restricted_sender_viewers ROWS, DELIBERATELY. An empty viewer list is the
-- strongest form of the rule: Stripe mail is hidden from EVERY DelegationDoer
-- user, Mitchell included. It keeps arriving in Microsoft 365 and is read
-- there — DD simply stops surfacing it. (DD has no delete-thread API against
-- the clone, so it could not remove the mail itself even if asked.) Same
-- configuration the Deel rules use; see that migration's header.
--
-- ONE ROW IS ENOUGH for stripe.com. match_kind 'domain' matches the address's
-- domain OR any subdomain of it, so 'stripe.com' already covers e.stripe.com,
-- mail.stripe.com, notifications.stripe.com, invoice.stripe.com and anything
-- Stripe adds later. Never a substring test: "contains stripe.com" would also
-- match stripe.com.evil.tld, and "contains stripe" would match
-- stripecustomer.com.
--
-- Matching is CORRESPONDENT-wide, not sender-only: a thread matches if any
-- participant / last_from, or any message from/to/cc, is a Stripe address. So
-- our own outbound mail TO Stripe is hidden too, as is a thread that merely
-- cc's one. That is intended — matching only the newest sender would leak a
-- thread whose latest message is our own reply.
--
-- KNOWN OVER-MATCH, recorded so it is a decision and not a surprise later: if
-- we ever bill clients through Stripe, "payment received / payment failed /
-- dispute opened" notices are hidden from everyone too, and so is a human at
-- @stripe.com (a salesperson or a support rep). Mitchell asked for exactly
-- this and the mail is still in Outlook. Escape hatches, cheapest first — all
-- three are data changes, none needs a deploy:
--   1. insert into public.restricted_sender_viewers (rule_id, user_id)
--      values ('rs_stripe_com', '<user id>');   -- give one person access back
--   2. update public.restricted_senders set enabled = false
--       where id = 'rs_stripe_com';             -- lift the rule, keep viewers
--   3. delete the domain row and insert match_kind 'exact' rows for only the
--      noisy addresses.
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
    ('rs_stripe_com', 'stripe.com', 'domain', 'Stripe (payments/billing platform)', v_mitchell),
    -- Precautionary, and NOT observed in our mail at the time of writing:
    -- stripe.dev is Stripe's developer domain (changelog / API digests) and is
    -- not a subdomain of stripe.com, so the row above would not cover it. An
    -- unmatched rule is inert — it costs one string compare per address — so
    -- this is cheap insurance rather than a guess with a downside. Drop this
    -- row if you would rather only restrict what has actually been seen.
    ('rs_stripe_dev', 'stripe.dev', 'domain', 'Stripe developer mail (stripe.dev)', v_mitchell)
  on conflict (id) do nothing;
end $$;
