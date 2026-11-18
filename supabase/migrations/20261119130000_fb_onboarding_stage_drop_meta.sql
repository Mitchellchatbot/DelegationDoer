-- Takes the "Meta leads" stage back out of FB onboarding: the reverse of
-- 20261119120000_fb_onboarding_stage_meta.sql.
--
-- The Meta SOP moved out of FB onboarding into its own page
-- (/meta-onboarding, table meta_onboarding), so stage() in
-- src/lib/fb-onboarding.ts no longer emits 'meta'. This puts the check
-- constraint back to exactly the stages the code can emit, which is what
-- scripts/check-fb-onboarding-sop.mjs asserts.
--
-- A client that entered 'meta' while #538 was live first gets its stage set
-- to NULL, which fb_onboarding_reconcile() treats as "adopt the computed
-- stage on the next tick". Without that, re-adding the constraint would fail
-- on such a row. Nothing else in the row is touched.
--
-- Safe in either order relative to the deploy:
--   - applied before the new code is live: a tick that still computes 'meta'
--     hits a 23514 on this constraint, which isStageConstraintError already
--     degrades to "no day-count chip";
--   - applied after: the code never emits 'meta' at all.
--
-- Idempotent. Apply MANUALLY in the Supabase SQL editor. Merging the PR runs
-- nothing in this repo. The last statement is a check: read its one row.

update public.fb_onboarding set stage = null where stage = 'meta';

alter table public.fb_onboarding drop constraint if exists fb_onboarding_stage_check;
alter table public.fb_onboarding
  add constraint fb_onboarding_stage_check
  check (stage is null or stage in ('access', 'launch', 'sync', 'main', 'setup', 'test', 'live'));

notify pgrst, 'reload schema';

-- Expect ONE row: allows_meta = false, rows_in_meta = 0.
select
  pg_get_constraintdef(c.oid) like '%''meta''%'                         as allows_meta,
  (select count(*) from public.fb_onboarding where stage = 'meta')      as rows_in_meta
from pg_constraint c
where c.conname = 'fb_onboarding_stage_check';
