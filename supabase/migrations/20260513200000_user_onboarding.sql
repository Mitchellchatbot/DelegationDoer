-- Onboarding completion marker. Set when the user finishes (or
-- explicitly dismisses) the first-login onboarding flow so we don't
-- keep popping the modal at them. Null = hasn't been through it yet.
--
-- Backfill: everyone who already exists when this migration runs is
-- by definition not a "new" employee and shouldn't see the popup,
-- so we mark them onboarded immediately. Only fresh invitees going
-- forward will land with onboarded_at = null and trigger the wizard.

alter table public.users
  add column if not exists onboarded_at timestamptz;

update public.users
   set onboarded_at = coalesce(onboarded_at, now())
 where onboarded_at is null;
