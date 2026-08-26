-- Adds the Facebook department (dep_facebook) - the first department added
-- since the original four were seeded in 20260505000000_init.sql.
--
-- Departments are rows, not an enum: public.departments is the single
-- catalog and every runtime surface reads it through getDepartments()
-- (src/lib/server-data.ts) or GET /api/departments, so a new row shows up
-- in the pickers, org chart, board filters and EOD/SOD scopes on its own.
--
-- description + task_types are load-bearing, not documentation:
-- /api/ai/route-department, lib/email-classifier.ts, lib/meeting-classifier.ts,
-- lib/email-intake.ts and lib/tldv-intake.ts splice them verbatim into the
-- classifier prompt, so they decide which incoming tasks, emails and meeting
-- action items route here. Facebook/Instagram/Meta are named explicitly to
-- disambiguate from Marketing, which also claims "paid ads ... social".
--
-- Created with NO members. The Leader Console -> People tab stays the source
-- of truth for org structure, same convention as the org-seed migrations
-- (20260528000001, 20260720000000).
--
-- slack_channel_id / task_channel_id are left null - those are set in the UI
-- (Settings / Leader Console -> DepartmentSlackSection).
--
-- Idempotent. Guarded rather than a bare upsert: departments.name is UNIQUE,
-- so if a "Facebook" row already exists under a different id, an id-keyed
-- upsert would trip the name constraint with an opaque error. Fail loudly
-- instead, matching the raise-exception style of 20260805000000.

do $$
begin
  if exists (
    select 1 from public.departments
     where lower(name) = 'facebook' and id <> 'dep_facebook'
  ) then
    raise exception
      'A department named Facebook already exists under a different id - reconcile before running this';
  end if;
end $$;

insert into public.departments (id, name, description, task_types) values
  ('dep_facebook', 'Facebook',
   'Facebook and Instagram (Meta) - paid campaigns plus organic page and community management.',
   array['ad campaign setup','ad creative','audience build','pixel/conversions setup',
         'budget adjustment','ads reporting','page post','content calendar',
         'community management','comment/DM response'])
on conflict (id) do update
  set name        = excluded.name,
      description = excluded.description,
      task_types  = excluded.task_types;
