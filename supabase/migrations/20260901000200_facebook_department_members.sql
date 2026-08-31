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
-- EMAIL IS PREFERRED, display name is the fallback. users.email is UNIQUE, so
-- an email match is exact; display names have drifted before, which is why
-- 20260720000000_seo_org_structure_email_keyed.sql had to re-do a name-keyed
-- seed after emily@scaledai.org started rendering as "Komal". But DD emails are
-- ALIASES that do not resemble the person (Altamash = austin@, Talha = james@,
-- Mujtaba = mike@), so a configured address going stale is routine -- and an
-- email-only match then drops that person with no way to see which one, because
-- the SQL editor eats the RAISE that would have named them. Hence the tier:
-- email wins where it matches, the name pattern catches the rest, and anything
-- matching two people is skipped rather than guessed. Nothing bad can be
-- written either way -- the user_id foreign key rejects a bad id outright.
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

-- RESOLUTION IS TIERED: exact email first, display name as a fallback.
--
-- An earlier revision keyed on email alone and aborted when one of the eight
-- addresses didn't match a users row. That is the right instinct -- a wrong
-- email must never silently omit somebody -- but it dead-ends the operator,
-- because the Supabase SQL editor does not surface the RAISE that names the
-- offending address. DD emails are aliases (Altamash = austin@, Talha = james@,
-- Mujtaba = mike@) and they drift, so "the configured email is stale" is a
-- routine state, not an exceptional one.
--
-- So: match on email OR display name, prefer whichever is more reliable
-- (email = rank 1, name = rank 2), and only consider candidates at the winning
-- rank -- a good email match can never be dragged into ambiguity by a loose
-- name match. A label matching MORE than one user at its winning rank is
-- SKIPPED, never guessed.
--
-- REPORTING IS VIA RESULT GRIDS, not RAISE NOTICE. Same reason: the SQL editor
-- swallows notices, so a migration that reports only through them is, in this
-- environment, a migration that reports nothing. Run the preview block at the
-- bottom of this comment FIRST to see exactly who resolves and how; the file
-- ends with a SELECT of the resulting roster so the outcome is always visible.
--
-- PREVIEW (read-only -- run this on its own before the file below):
--
--   with targets(email, name_pat, label) as (values
--     ('austin@scaledai.org',     'altamash|rajpoot',              'Altamash Rajpoot'),
--     ('henry@scaledai.org',      'hasan',                         'Hasan Reza'),
--     ('james@scaledai.org',      'talha',                         'Talha Ali'),
--     ('mazzaj609@gmail.com',     'mazza',                         'Joe Mazza (Slack "JM")'),
--     ('mechael@scaledai.org',    'mecheal|mechael|michael.*syed', 'Mechael Syed'),
--     ('mike@scaledai.org',       'mujtaba',                       'Mujtaba'),
--     ('mitchell@scaledai.org',   'mitchell',                      'Mitchell'),
--     ('shaheerkhosa6@gmail.com', 'shaheer',                       'Shaheer Khosa')
--   ), hits as (
--     select t.label, u.id, u.name, u.email, u.role,
--            case when lower(u.email) = lower(t.email) then 1 else 2 end as rk
--       from targets t join public.users u
--         on lower(u.email) = lower(t.email) or u.name ~* t.name_pat
--   ), best as (select label, min(rk) rk from hits group by label),
--   winners as (
--     select h.*, count(*) over (partition by h.label) n
--       from hits h join best b on b.label = h.label and b.rk = h.rk)
--   select t.label, t.email as configured_email, coalesce(w.n,0) as candidates,
--          w.name as matched_name, w.email as matched_email, w.role
--     from targets t left join winners w on w.label = t.label
--    order by (w.id is not null), t.label, w.name;

drop table if exists _fb_targets;
create temp table _fb_targets (email text, name_pat text, label text);

-- email        -- the address we believe they use. May be stale; that is fine.
-- name_pat     -- case-insensitive regex fallback on users.name.
-- label        -- who this row is meant to be, for the report.
insert into _fb_targets (email, name_pat, label) values
  ('austin@scaledai.org',     'altamash|rajpoot',              'Altamash Rajpoot'),
  ('henry@scaledai.org',      'hasan',                         'Hasan Reza'),
  ('james@scaledai.org',      'talha',                         'Talha Ali'),
  ('mazzaj609@gmail.com',     'mazza',                         'Joe Mazza (Slack "JM")'),
  ('mechael@scaledai.org',    'mecheal|mechael|michael.*syed', 'Mechael Syed'),
  ('mike@scaledai.org',       'mujtaba',                       'Mujtaba'),
  ('mitchell@scaledai.org',   'mitchell',                      'Mitchell'),
  ('shaheerkhosa6@gmail.com', 'shaheer',                       'Shaheer Khosa');

-- Guard: dep_facebook must exist. Migrations here are applied BY HAND; merging
-- a PR runs nothing, so it may not be in this database yet.
do $$
begin
  if not exists (select 1 from public.departments where id = 'dep_facebook') then
    raise exception
      'dep_facebook is missing -- apply 20260826000100_facebook_department.sql first (merging its PR did not run it).';
  end if;
end $$;

-- Resolve, then insert only labels that landed on exactly ONE user at their
-- winning rank. Ambiguous and unresolved labels are left out and shown in the
-- report below -- skipping is always safe, guessing is not.
with hits as (
  select t.label, u.id,
         case when lower(u.email) = lower(t.email) then 1 else 2 end as rk
    from _fb_targets t
    join public.users u
      on lower(u.email) = lower(t.email)
      or u.name ~* t.name_pat
),
best as (select label, min(rk) as rk from hits group by label),
winners as (
  select h.label, h.id, count(*) over (partition by h.label) as n
    from hits h
    join best b on b.label = h.label and b.rk = h.rk
)
insert into public.department_members (user_id, department_id)
select distinct w.id, 'dep_facebook'
  from winners w
 where w.n = 1
on conflict do nothing;

-- THE REPORT. A result grid, because RAISE NOTICE is invisible here. One row
-- per target: whether it resolved, how, and whether they are now a member.
-- Anything that is not 'ok' needs a human -- fix the email or the name pattern
-- and re-run; this file is idempotent.
with hits as (
  select t.label, t.email as configured_email, u.id, u.name, u.email, u.role,
         case when lower(u.email) = lower(t.email) then 1 else 2 end as rk
    from _fb_targets t
    join public.users u
      on lower(u.email) = lower(t.email)
      or u.name ~* t.name_pat
),
best as (select label, min(rk) as rk from hits group by label),
winners as (
  select h.*, count(*) over (partition by h.label) as n
    from hits h
    join best b on b.label = h.label and b.rk = h.rk
)
select
  case
    when w.id is null then 'NOT FOUND -- fix email or name_pat, re-run'
    when w.n > 1      then 'AMBIGUOUS -- skipped, ' || w.n || ' candidates'
    when w.rk = 1     then 'ok (matched on email)'
    else                   'ok (matched on NAME -- configured email is stale)'
  end                                        as status,
  t.label,
  t.email                                    as configured_email,
  w.name                                     as matched_name,
  w.email                                    as matched_email,
  w.role,
  exists (
    select 1 from public.department_members dm
     where dm.user_id = w.id and dm.department_id = 'dep_facebook'
  )                                          as now_a_member
from _fb_targets t
left join winners w on w.label = t.label
order by (w.id is not null and w.n = 1), t.label, w.name;

-- NOTE: _fb_targets is deliberately NOT dropped here. A temp table dies with
-- the session anyway, and the leading "drop table if exists" already makes a
-- re-run clean -- whereas a trailing DROP would be the LAST statement in the
-- file, and the Supabase SQL editor shows the LAST result set. Ending on a
-- DROP would hide the report above, which is the whole point of this file.
