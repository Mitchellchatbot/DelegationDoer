-- Facebook client onboarding — the access / setup / test checklist that lives
-- on a Facebook department task (one task per client).
--
-- One row per task. Everything the onboarder ticks, picks or types lives in
-- `state`, a FLAT jsonb map of key -> { v, by, at } so every entry carries who
-- set it and when. The set of valid keys is defined in src/lib/fb-onboarding.ts;
-- the API rejects anything else, so the shape here stays deliberately loose.
--
-- Writes go through fb_onboarding_set() so two people ticking different boxes
-- at once can't clobber each other (a read-modify-write from the app would).
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

create table if not exists public.fb_onboarding (
  task_id      text primary key references public.tasks(id) on delete cascade,
  state        jsonb not null default '{}'::jsonb,
  started_by   text references public.users(id) on delete set null,
  started_at   timestamptz not null default now(),
  -- Stamped by the API when access, setup and tests are all green; cleared
  -- again if something is un-ticked afterwards.
  completed_at timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.fb_onboarding enable row level security;

-- Atomic single-key merge. Returns the full merged state so the caller can
-- recompute completion off exactly what was stored.
create or replace function public.fb_onboarding_set(
  p_task_id text,
  p_key     text,
  p_entry   jsonb
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  update public.fb_onboarding
     set state      = state || jsonb_build_object(p_key, p_entry),
         updated_at = now()
   where task_id = p_task_id
  returning state;
$$;
