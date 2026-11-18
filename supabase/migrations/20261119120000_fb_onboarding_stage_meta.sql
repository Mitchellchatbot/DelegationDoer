-- Adds the "Meta leads" stage (Meta Instant Form leads through one Zap into
-- Scaled Sync and the Scaled Admissions AI) between Scaled Sync and Build.
-- stage() in src/lib/fb-onboarding.ts now emits 'meta' for a client on that
-- route that has cleared Access, Launch and Scaled Sync but hasn't finished
-- the Meta leads tab, and fb_onboarding_reconcile() writes whatever stage()
-- computed straight into this column — so the check constraint has to accept
-- it too.
--
-- Exactly the same shape as 20261007120000_fb_onboarding_stage_sync.sql,
-- which added 'sync' for the same reason.
--
-- No backfill, and none needed: the phase is gated on meta.route, which no
-- existing onboarding has set, so every one of them keeps counting 0/0 here
-- and keeps the stage it already had.
--
-- Safe to merge before this runs: the API route treats a 23514 on this
-- constraint (isStageConstraintError) as "migration not applied yet", so a
-- client moving into 'meta' still saves and completes; only its day-count chip
-- is missing until this is applied.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

alter table public.fb_onboarding drop constraint if exists fb_onboarding_stage_check;
alter table public.fb_onboarding
  add constraint fb_onboarding_stage_check
  check (stage is null or stage in ('access', 'launch', 'sync', 'meta', 'main', 'setup', 'test', 'live'));

notify pgrst, 'reload schema';
