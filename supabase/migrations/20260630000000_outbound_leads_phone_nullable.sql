-- Manual lead entry for the outbound funnel.
--
-- Until now every outbound_leads row was created by the Typeform webhook,
-- which always has a phone_number field — so phone was NOT NULL UNIQUE and
-- doubled as the dedup key. Operators can now add leads by hand, including
-- leads that only have an email (referrals, calls, events). Phone therefore
-- becomes optional, and we rework the uniqueness so:
--   - real phones stay unique (still the Typeform/Calendly dedup key)
--   - many email-only leads (phone IS NULL) can coexist
--   - email becomes a dedup identity for email-only leads
alter table public.outbound_leads alter column phone drop not null;

-- The original inline `phone text not null unique` was auto-named
-- outbound_leads_phone_key. Drop it and replace with a partial unique index
-- so NULL phones don't collide.
alter table public.outbound_leads drop constraint if exists outbound_leads_phone_key;
create unique index if not exists outbound_leads_phone_uniq
  on public.outbound_leads (phone) where phone is not null;

-- Email becomes an identity for email-only leads; dedup on it too.
--
-- Email was NEVER unique before (only phone was), so the table may already
-- contain two leads sharing an email — e.g. the same person who submitted
-- Typeform twice from different phones. A bare CREATE UNIQUE INDEX would
-- abort this whole migration (rolling back the DROP NOT NULL above) in that
-- case. Guard it: only create the index when the data is actually clean,
-- otherwise raise a NOTICE and leave the app-layer dedup in
-- lib/outbound-leads.ts:createLeadManual as the safety net. The phone index
-- above needs no such guard — phone was already unique.
do $$
begin
  if exists (
    select 1 from public.outbound_leads
    where email is not null
    group by lower(email)
    having count(*) > 1
  ) then
    raise notice 'outbound_leads has duplicate emails; skipping outbound_leads_email_uniq. Dedup is enforced in app code (createLeadManual).';
  else
    create unique index if not exists outbound_leads_email_uniq
      on public.outbound_leads (lower(email)) where email is not null;
  end if;
end $$;
