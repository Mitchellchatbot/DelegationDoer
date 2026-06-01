-- Onboarding & contact info captured at client-creation time. Lets the
-- New Client modal store the key context a team needs when they start
-- working an account, instead of just name + website.
--
--   - onboarding_date       When the client came on board (date picker).
--   - business_information  Free-text brief: company overview, products /
--                           services, background, special instructions —
--                           anything the team should know.
--
-- Both are optional and nullable so existing rows are unaffected. The
-- primary contact name and email already live in contact_name /
-- contact_emails (added in 20260518000000_clients_table.sql), so the
-- modal writes those columns and no new ones are needed for contact.

alter table public.clients
  add column if not exists onboarding_date date,
  add column if not exists business_information text;
