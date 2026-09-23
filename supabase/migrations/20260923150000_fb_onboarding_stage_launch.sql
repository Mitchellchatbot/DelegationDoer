-- Adds the "Launch" stage (cities, starting budget, ad creative link) between
-- Access and Build. stage() in src/lib/fb-onboarding.ts now emits 'launch' for
-- a client that has cleared Access but hasn't finished those three fields yet,
-- and fb_onboarding_reconcile() writes whatever stage() computed straight into
-- this column — so the check constraint has to accept it too, or every PATCH
-- on a client sitting in Launch starts failing with a constraint violation.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

alter table public.fb_onboarding drop constraint if exists fb_onboarding_stage_check;
alter table public.fb_onboarding
  add constraint fb_onboarding_stage_check
  check (stage is null or stage in ('access', 'launch', 'main', 'setup', 'test', 'live'));

notify pgrst, 'reload schema';
