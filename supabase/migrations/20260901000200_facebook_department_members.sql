-- Add the members of the Slack #facebook channel to the Facebook department.
--
-- 20260826000100_facebook_department.sql created dep_facebook with ZERO
-- members, deferring org structure to the Leader Console. That left the
-- department looking broken: on the task board's default per-person view,
-- selecting a department filters the columns to its members and any task whose
-- assignee has no column is DROPPED rather than bucketed -- so with no members,
-- every assigned Facebook task was invisible. The New-task assignee dropdown
-- came back empty for the same reason. This is the catch-up.
--
-- WHAT THIS TOUCHES: rows in public.department_members. Nothing else. It does
-- not write users.role, users.manager_user_id, or any other table, and it
-- deletes nothing -- so no role, reporting line or permission is changed here.
-- Re-running is a clean no-op (composite PK + `on conflict do nothing`), which
-- is the intended way to add anyone still missing below.
--
-- Hamza is deliberately NOT in this list -- he has left the company.
--
-- Keyed by EMAIL, never by display name. users.email is UNIQUE, and DD display
-- names have drifted before -- 20260720000000_seo_org_structure_email_keyed.sql
-- exists precisely because a name-keyed seed silently mis-targeted after
-- emily@scaledai.org started rendering as "Komal". Note DD emails are aliases
-- that do not resemble the person's name (Altamash = austin@, Talha = james@,
-- Mujtaba = mike@), which is exactly why guessing is not an option here. A
-- wrong or absent email matches zero rows and is REPORTED; it never writes bad
-- data, and the user_id foreign key would reject a bad id outright.
--
-- KNOWN CONSEQUENCE, recorded because it is not obvious: Mujtaba, Talha Ali and
-- Hasan Reza already have role='department_head' (Website, Marketing, Software),
-- and role in DD is GLOBAL rather than per-department. Before 20260901000100
-- that would have made all three de-facto Facebook heads -- each fielding the
-- start-of-day DM that api/sod/submit fans out, and each a candidate for
-- Facebook intake -- for a team none of them runs.
--
-- That is why 20260901000100 must be applied BEFORE this file. With
-- departments.head_user_id in place, "who leads Facebook" is answered by that
-- column, which is deliberately NULL: intake routes to the ranker / routing
-- review and start-of-day updates notify only leaders. The one leftover is
-- cosmetic and known -- the org chart still lists all three under Facebook,
-- because it reads the global role. This file changes no roles either way.

-- drop-then-create, not a bare create: the guard below can raise, and under psql
-- autocommit the create has already committed by then, so a bare create would
-- make every retry die with "relation _fb_targets already exists" -- in exactly
-- the situation the guard exists to catch.
drop table if exists _fb_targets;
create temp table _fb_targets (email text primary key, label text);
-- All eight, confirmed against Leader Console -> People. Two of them are also
-- corroborated by earlier migrations, which is a useful cross-check that these
-- are the right rows: henry@scaledai.org is the address 20260618000000_
-- promote_hasan_admin.sql pins Hasan to, and mechael@scaledai.org satisfies the
-- '%mechael%@scaledai.org' arm of 20260527000000_promote_mecheal_admin.sql
-- (which hedged across Mecheal/Mechael/Michael because the spelling was unknown).
insert into _fb_targets (email, label) values
  ('austin@scaledai.org',      'Altamash Rajpoot'),
  ('henry@scaledai.org',       'Hasan Reza'),
  ('james@scaledai.org',       'Talha Ali'),
  ('mazzaj609@gmail.com',      'Joe Mazza (Slack "JM")'),
  ('mechael@scaledai.org',     'Mechael Syed'),
  ('mike@scaledai.org',        'Mujtaba'),
  ('mitchell@scaledai.org',    'Mitchell'),
  ('shaheerkhosa6@gmail.com',  'Shaheer Khosa');

-- ============================================================
-- STEP 1 -- Guard. Migrations in this project are applied BY HAND; merging a
-- PR runs nothing, so dep_facebook may not exist in this database yet.
-- ============================================================
do $$
begin
  if not exists (select 1 from public.departments where id = 'dep_facebook') then
    raise exception
      'dep_facebook is missing -- apply 20260826000100_facebook_department.sql first (merging its PR did not run it).';
  end if;
end $$;

-- ============================================================
-- STEP 2 -- Preview every target, insert, then report the real post-state.
-- Both halves read the single list above, so the preview and the write
-- cannot drift apart.
-- ============================================================
do $$
declare
  rec     record;
  n_want  int;
  n_found int;
  n_added int;
  n_heads int;
begin
  select count(*) into n_want from _fb_targets;
  raise notice '=== Facebook members :: PREVIEW (% target emails) ===', n_want;

  for rec in
    select t.label, t.email, u.id, u.name, u.role, u.is_admin,
           (select string_agg(d.name, ' + ' order by d.name)
              from public.department_members dm
              join public.departments d on d.id = dm.department_id
             where dm.user_id = u.id) as depts
      from _fb_targets t
      left join public.users u on lower(u.email) = lower(t.email)
     order by t.label
  loop
    if rec.id is null then
      raise warning '  NOT FOUND  % <%>  -- skipped. Fix the email and re-run.',
        rec.label, rec.email;
    else
      raise notice '  ok  % <%>  role=% admin=% depts=[%]',
        rec.label, rec.email, rec.role, rec.is_admin, coalesce(rec.depts, 'none');
    end if;
  end loop;

  insert into public.department_members (user_id, department_id)
  select u.id, 'dep_facebook'
    from _fb_targets t
    join public.users u on lower(u.email) = lower(t.email)
  on conflict do nothing;
  get diagnostics n_added = row_count;

  -- count(distinct t.email), not count(*): users.email is UNIQUE on the RAW
  -- value, not on lower(email), so two accounts differing only in case both
  -- match one target. With count(*) a missing person plus a case-duplicate
  -- would cancel out to n_found = n_want and the check below would never fire.
  select count(distinct t.email) into n_found
    from _fb_targets t
    join public.users u on lower(u.email) = lower(t.email);

  raise notice '=== RESULT ===';
  raise notice 'emails resolved : % of %', n_found, n_want;
  raise notice 'rows added      : %   (any remainder were already members)', n_added;
  raise notice 'dep_facebook roster is now:';

  for rec in
    select u.name, u.email, u.role
      from public.department_members dm
      join public.users u on u.id = dm.user_id
     where dm.department_id = 'dep_facebook'
     order by u.name
  loop
    raise notice '   . % <%> role=%', rec.name, rec.email, rec.role;
  end loop;

  -- Exception, not warning. The Supabase SQL editor does not reliably surface
  -- NOTICE/WARNING output and this project applies migrations by hand, so a
  -- typo would otherwise leave someone quietly missing from the department with
  -- nobody the wiser. Raising rolls the insert back; fix the address (or delete
  -- that row from _fb_targets if you really do mean to proceed short-handed)
  -- and re-run.
  if n_found <> n_want then
    raise exception
      'Only % of % target emails resolved to a DD user -- see the NOT FOUND lines above. Fix the address(es) and re-run; this file is idempotent.',
      n_found, n_want;
  end if;

  select count(*) into n_heads
    from public.department_members dm
    join public.users u on u.id = dm.user_id
   where dm.department_id = 'dep_facebook' and u.role = 'department_head';

  if n_heads > 1 then
    raise notice 'FYI: % of these members carry role=department_head because they lead OTHER teams (role is global, not per-department). They are NOT treated as Facebook heads: departments.head_user_id decides that, and Facebook has none, so intake routes to the ranker / routing review and start-of-day updates notify only leaders. The org chart still lists them under Facebook -- cosmetic, and known. No role was changed by this migration.', n_heads;
  end if;
end $$;

drop table if exists _fb_targets;
