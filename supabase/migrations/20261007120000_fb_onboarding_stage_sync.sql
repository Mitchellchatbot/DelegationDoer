-- Adds the "Scaled Sync" stage (their CRM account, and their Typeform pointed
-- at it) between Launch and Build. stage() in src/lib/fb-onboarding.ts now
-- emits 'sync' for a client on Scaled Sync that has cleared Access and Launch
-- but hasn't finished that tab, and fb_onboarding_reconcile() writes whatever
-- stage() computed straight into this column — so the check constraint has to
-- accept it too, or every PATCH on a client sitting in Scaled Sync starts
-- failing with a constraint violation.
--
-- Exactly the same shape as 20260923150000_fb_onboarding_stage_launch.sql,
-- which added 'launch' for the same reason.
--
-- No backfill, and none needed: the phase is gated on sync.platform, which no
-- existing onboarding has set, so every one of them keeps counting 0/0 here
-- and keeps the stage it already had.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

alter table public.fb_onboarding drop constraint if exists fb_onboarding_stage_check;
alter table public.fb_onboarding
  add constraint fb_onboarding_stage_check
  check (stage is null or stage in ('access', 'launch', 'sync', 'main', 'setup', 'test', 'live'));

notify pgrst, 'reload schema';
