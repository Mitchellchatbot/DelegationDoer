-- Stage dwell time on Facebook client onboarding.
--
-- The list shows one of five stages per client — Access → Build → Setup →
-- Testing → Live — and how many days it has sat there. The stage itself is
-- DERIVED from the checklist by stage() in src/lib/fb-onboarding.ts, never
-- typed by a human, and "Live" means nothing more than completed_at being set.
--
-- Two columns and one new function beside fb_onboarding_set().
--
-- WHY `stage` IS A COLUMN AT ALL
--
-- It is NOT a cache of the derived value and nothing displays it. It exists so
-- the write path can tell a REAL stage change from a re-save: stage_entered_at
-- must move only on an actual transition, the same rule tasks.completed_at
-- follows. That comparison has to happen inside the UPDATE, under the row lock
-- the UPDATE already takes. Doing it in app code would mean SELECT-then-UPDATE,
-- which is the race fb_onboarding_reconcile() below exists to REMOVE, not add
-- to. The ladder is TypeScript (its totals are module constants), so SQL cannot
-- recompute it; the app passes the new stage in and this function compares.
--
-- Readers do not trust this column. listOnboardings() recomputes the stage in
-- TypeScript from state + completed_at on every request, so a stale value can
-- never reach a user. Stage ids match the panel's tab ids — note 'main' is the
-- id the product calls "Build"; the id stays 'main' so it lines up with the
-- main.* keys inside `state`. Please don't "fix" it.
--
-- WHY THERE IS NO hold_since / waiting_since COLUMN
--
-- "On hold" and "who we're waiting on" are ordinary checklist keys inside
-- `state` (hold.active, hold.note, waiting.on, waiting.note). Every entry in
-- `state` already carries { v, by, at }, so state->'hold.active'->>'at' IS
-- "held since", stamped by the same code path as every other tick. A column
-- would be a second source of truth for a fact we already have for free.
--
-- NO INDEX, deliberately. One row per Facebook client — tens, ever — and
-- listOnboardings selects all of them unfiltered and sorts by updated_at.
-- Nothing filters or orders by either new column. Please don't add one out of
-- habit.
--
-- BACKFILL
--
-- The ladder cannot run in SQL, so only the last rung is computable here:
-- completed_at is not null => 'live'. Every other row keeps stage NULL and is
-- adopted, WITHOUT a stamp, by the first fb_onboarding_reconcile() call (see
-- the `f.stage is not null` guard).
--
-- stage_entered_at backfills from completed_at where the row is already live
-- (exact — that IS when it entered Live) and otherwise from updated_at.
-- updated_at under-reports: a row stuck in Access for a month but ticked
-- yesterday reads as one day old. That is the safe direction — it can only
-- fail to raise an alarm, never raise a false one — it self-corrects at the
-- first real transition, and it is defensible on the merits: a row someone
-- touched yesterday is being worked, not aging. started_at was rejected; it
-- would show every existing onboarding as weeks old on day one and light the
-- whole list red for no reason.
--
-- ORDER MATTERS: columns are added WITHOUT defaults, backfilled, and only THEN
-- given defaults. A DEFAULT on ADD COLUMN is applied to existing rows
-- (fast-default; now() is STABLE so it qualifies), which would fill every row
-- with this statement's own clock and leave the `where ... is null` backfill
-- with nothing to do.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

alter table public.fb_onboarding
  add column if not exists stage            text,
  add column if not exists stage_entered_at timestamptz;

-- The only rung SQL can compute.
update public.fb_onboarding
   set stage = 'live'
 where stage is null
   and completed_at is not null;

update public.fb_onboarding
   set stage_entered_at = coalesce(completed_at, updated_at)
 where stage_entered_at is null;

-- Defaults AFTER the backfill. These are what make POST /fb-onboarding need no
-- change at all: a new row is stamped correctly without a line of TypeScript.
alter table public.fb_onboarding alter column stage            set default 'access';
alter table public.fb_onboarding alter column stage_entered_at set default now();

-- Stays NULLABLE forever: NULL is the meaningful "recorded before this
-- migration, adopt me without stamping" value the function keys off.
alter table public.fb_onboarding drop constraint if exists fb_onboarding_stage_check;
alter table public.fb_onboarding
  add constraint fb_onboarding_stage_check
  check (stage is null or stage in ('access', 'main', 'setup', 'test', 'live'));

-- Sibling of fb_onboarding_set(). Deliberately a SEPARATE function with a new
-- name: changing fb_onboarding_set's return shape would break progress() at
-- RUNTIME with no compile error, because .rpc() returns `any` and the route
-- casts it straight to OnboardingState. progress() would then find none of its
-- keys, report 0 done on every axis, and clear completed_at on every live
-- onboarding. A new name means old deployed code keeps getting exactly what it
-- always got, so this file and the app can be applied in either order.
--
-- One statement replaces the route's SELECT-then-UPDATE on completed_at, which
-- was an unguarded read-then-write two concurrent PATCHes could race: a stale
-- `complete` verdict computed from a superseded state could clear a
-- completed_at that a newer tick had just stamped.
--
-- The guard is `state = p_state`: a verdict may only be applied while the row
-- still holds the exact state it was computed from. jsonb equality is exact
-- here — `state` is a flat map of string/boolean leaves with no numbers and no
-- key-order dependence. If another PATCH landed first this one reports
-- applied=false and does nothing; that other PATCH carries its own, fresher
-- verdict, so dropping this one is not merely safe, it is correct.
--
-- Does NOT touch updated_at: that means "when the checklist last changed", and
-- fb_onboarding_set already set it for this same change. Does NOT touch tasks
-- either, keeping the security-definer surface to this one table.
create or replace function public.fb_onboarding_reconcile(
  p_task_id  text,
  p_state    jsonb,
  p_stage    text,
  p_complete boolean,
  p_now      timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage   text;
  v_entered timestamptz;
  v_done    timestamptz;
begin
  update public.fb_onboarding f
     set stage = p_stage,
         -- Stamped ONLY on a real transition, mirroring how tasks.completed_at
         -- is stamped only when the status actually crosses the boundary.
         -- stage IS NULL means "pre-migration row, adopt without stamping" —
         -- the backfilled stage_entered_at above is the truth we keep.
         stage_entered_at = case
           when f.stage is not null and f.stage is distinct from p_stage then p_now
           else coalesce(f.stage_entered_at, p_now)
         end,
         -- Same outcomes as the TypeScript it replaces, written as an
         -- invariant rather than a transition, so it is idempotent and
         -- self-healing. coalesce keeps the original stamp on a re-save.
         completed_at = case
           when p_complete then coalesce(f.completed_at, p_now)
           else null
         end
   where f.task_id = p_task_id
     and f.state   = p_state
  returning f.stage, f.stage_entered_at, f.completed_at
       into v_stage, v_entered, v_done;

  if found then
    return jsonb_build_object(
      'applied', true, 'stage', v_stage,
      'stageEnteredAt', v_entered, 'completedAt', v_done);
  end if;

  -- Lost the race, or the row is gone. Hand back what is actually stored so
  -- the caller can answer the client with the truth instead of its own guess.
  select f.stage, f.stage_entered_at, f.completed_at
    into v_stage, v_entered, v_done
    from public.fb_onboarding f
   where f.task_id = p_task_id;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'applied', false, 'stage', v_stage,
    'stageEnteredAt', v_entered, 'completedAt', v_done);
end;
$$;

-- Required for BOTH the new columns and the new function to appear in
-- PostgREST's schema cache. Skip it and the PATCH route keeps taking its
-- "function not provisioned" fallback (PGRST202) even though the function
-- exists — with no error anywhere to tell you why.
notify pgrst, 'reload schema';

-- The SQL editor swallows RAISE NOTICE, so verify by selecting. Expect:
-- rows_total = with_entered_at, reconcile_fn = 1, stage_default = 'access'::text.
select
  (select count(*) from public.fb_onboarding)                                     as rows_total,
  (select count(*) from public.fb_onboarding where stage_entered_at is not null)  as with_entered_at,
  (select count(*) from public.fb_onboarding where stage = 'live')                as live_rows,
  (select count(*) from public.fb_onboarding where stage is null)                 as awaiting_adoption,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fb_onboarding_reconcile')         as reconcile_fn,
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'fb_onboarding'
      and column_name = 'stage')                                                  as stage_default;
