-- =============================================================================
-- SEO team rosters, as sent 2026-10-15: who is on each SEO team lead's team.
--
--   Saifullah (steve@scaledai.org)  -> Fana, Mustajab, Wasi
--   Samir     (samir@scaledai.org)  -> Abeer, Komal, Azam
--   Bismah    (bella@scaledai.org)  -> Nabil, Mareeha
--
-- Versus 20260720000000_seo_org_structure_email_keyed.sql: Komal moves from
-- Bismah to Samir, and Wasi, Azam and Mareeha get a reporting line for the first
-- time (commit de2f519 noted they had none).
--
-- WHY THE ORG CHART: the "+N" next to each lead on /client-teams, and the team
-- named on hover, is not stored anywhere of its own. client-teams/page.tsx
-- derives it from users.manager_user_id / secondary_manager_user_id -- everyone
-- who reports to the lead. So the roster IS the reporting lines, and changing
-- it also changes, for these people:
--   * whose EOD DM they trigger -- api/eod/submit DMs the primary AND the
--     secondary manager, so Samir (not Bismah) gets Komal's from now on;
--   * who may assign them tasks -- a worker lead can assign only to people
--     whose PRIMARY manager is them (canAssignTaskTo / assignableTargets);
--   * where they sit in the org chart (People).
-- Which lead owns which SITE is a separate field (clients.team_id) and is NOT
-- touched here; scripts/seo-team-split.mjs reconciles that, dry run first.
--
-- WHAT THIS WRITES, only when v_apply is true, and only for roster people who
-- resolve to exactly one user:
--   * manager_user_id := their lead;
--   * secondary_manager_user_id := null, but ONLY when it points at one of the
--     three leads. Otherwise Komal would still count on Bismah's team through a
--     leftover link (the page counts secondary links too), and a secondary equal
--     to the new primary would break users_secondary_manager_not_primary. A
--     secondary manager outside the three leads is left alone.
--
-- WHAT THIS DOES NOT DO, deliberately:
--   * It does not touch anyone who is not on the roster. If someone else still
--     reports to one of the three leads, the report lists them as NOT ON ROSTER
--     and leaves them as they are -- the roster says who IS on each team, not
--     what should happen to anyone else. Move them in Leader Console -> People.
--   * No department_members rows. Membership is a permissions grant, not a
--     label. The report shows in_seo_department per person: the /client-teams
--     "+N" does not need it, but the org chart only draws someone under SEO if
--     they are a member. Add anyone missing from Leader Console -> People.
--   * No role changes.
--
-- MATCHING is tiered and never guesses (same as 20260901000200): exact email is
-- rank 1, a whole-word, case-insensitive match on the display name is rank 2,
-- and only candidates at a name's best rank count. A name that lands on more
-- than one user is SKIPPED; one that lands on nobody is reported NOT FOUND.
-- The emails are the ones 20260720000000 used. Wasi, Azam and Mareeha are
-- name-only, because no DD email for them is recorded anywhere in this repo.
-- The three LEADS are matched by email only -- the same addresses as
-- TEAMS[].leadEmail in src/lib/client-teams.ts, which is how the page finds
-- them -- and the file raises if one does not resolve to exactly one user.
--
-- HOW TO RUN -- PREVIEW FIRST:
--   1. Paste the whole file into the Supabase SQL editor and run it. v_apply is
--      false, so NOTHING is written. Read the grid at the bottom: one row per
--      roster name, plus a NOT ON ROSTER row for anyone else under a lead.
--   2. Only if it is right, change `v_apply boolean := false` to `true` and run
--      the file again. Every roster row should then read "ok". Re-runnable; it
--      converges.
--   3. NOT FOUND usually means the person has no DD account yet. Create it, or
--      put their DD email in the roster below, and re-run.
--
-- RAISE NOTICE is invisible in the Supabase SQL editor, so the report is a plain
-- trailing SELECT and anything genuinely dangerous is an exception.
-- =============================================================================

-- Top-of-file drops, not trailing ones: a trailing drop would hide the report,
-- and this makes a re-run after an aborted attempt clean.
drop table if exists _seo_roster;
drop table if exists _seo_plan;

create temp table _seo_roster (
  lead_email text not null,  -- the lead, exactly as TEAMS[].leadEmail
  lead_label text not null,
  email      text,           -- their DD email, when one is known (rank 1)
  name_pat   text not null,  -- whole-word, case-insensitive on users.name (rank 2)
  label      text not null   -- the name as it appears on the roster
);

insert into _seo_roster (lead_email, lead_label, email, name_pat, label) values
  ('steve@scaledai.org', 'Saif',   'fanaanwar01@gmail.com', '\mfana\M',     'Fana'),
  ('steve@scaledai.org', 'Saif',   'daniel@scaledai.org',   '\mmustajab\M', 'Mustajab'),
  ('steve@scaledai.org', 'Saif',   null,                    '\mwasi\M',     'Wasi'),
  ('samir@scaledai.org', 'Samir',  'aiden@scaledai.org',    '\mabeer\M',    'Abeer'),
  ('samir@scaledai.org', 'Samir',  'emily@scaledai.org',    '\mkomal\M',    'Komal'),
  ('samir@scaledai.org', 'Samir',  null,                    '\mazam\M',     'Azam'),
  ('bella@scaledai.org', 'Bismah', 'sophia@scaledai.org',   '\mnabil\M',    'Nabil'),
  ('bella@scaledai.org', 'Bismah', null,                    '\mmareeha\M',  'Mareeha');

-- -----------------------------------------------------------------------------
-- Resolve everyone once, before anything is written, into a plan. kind is
-- 'ready' only for a roster name that landed on exactly one user who is not a
-- lead and whom no other roster name also landed on. An AMBIGUOUS name keeps one
-- row per candidate, so the report can show who they were.
-- -----------------------------------------------------------------------------
create temp table _seo_plan as
with leads as (
  select distinct
         r.lead_email,
         (select min(u.id)  from public.users u where lower(trim(u.email)) = r.lead_email) as lead_id,
         (select count(*)   from public.users u where lower(trim(u.email)) = r.lead_email) as lead_rows
    from _seo_roster r
),
hits as (
  select r.label, u.id as user_id,
         case when lower(trim(u.email)) = lower(r.email) then 1 else 2 end as rk
    from _seo_roster r
    join public.users u
      on lower(trim(u.email)) = lower(r.email)
      or u.name ~* r.name_pat
),
best as (select label, min(rk) as rk from hits group by label),
winners as (
  select h.label, h.user_id, h.rk, count(*) over (partition by h.label) as n
    from hits h
    join best b on b.label = h.label and b.rk = h.rk
),
matched as (
  select r.lead_email, r.lead_label, r.email as configured_email, r.label,
         l.lead_id, l.lead_rows,
         w.user_id, w.rk, coalesce(w.n, 0) as n
    from _seo_roster r
    join leads l on l.lead_email = r.lead_email
    left join winners w on w.label = r.label
)
select m.*,
       case
         when m.user_id is null then 'not_found'
         when m.n > 1           then 'ambiguous'
         when m.user_id in (select lead_id from leads where lead_id is not null)
                                then 'is_lead'
         when exists (select 1 from matched o
                       where o.n = 1 and o.user_id = m.user_id and o.label <> m.label)
                                then 'claimed_twice'
         else                        'ready'
       end as kind
  from matched m;

do $$
declare
  -- ------------------------------------------------------------------------
  -- FLIP THIS TO true TO APPLY. Left false so the first run is a preview.
  -- ------------------------------------------------------------------------
  v_apply boolean := false;

  v_bad   text;
  v_moved int;
begin
  -- Each lead must be exactly one user. Without this, an unresolved lead would
  -- write manager_user_id = null and quietly take people OFF a team.
  select string_agg(distinct format('%s (%s users)', lead_email, lead_rows), ', ')
    into v_bad
    from _seo_plan
   where lead_rows <> 1;
  if v_bad is not null then
    raise exception
      'SEO lead email(s) do not resolve to exactly one user: %. /client-teams finds the leads by these same addresses (TEAMS[].leadEmail in src/lib/client-teams.ts), so fix that first rather than letting this file guess.',
      v_bad;
  end if;

  if not v_apply then
    return; -- preview only; the trailing SELECT still reports.
  end if;

  update public.users u
     set manager_user_id = p.lead_id,
         secondary_manager_user_id = case
           when u.secondary_manager_user_id in (select lead_id from _seo_plan) then null
           else u.secondary_manager_user_id
         end
    from _seo_plan p
   where p.kind = 'ready'
     and u.id = p.user_id
     and (u.manager_user_id is distinct from p.lead_id
          or u.secondary_manager_user_id in (select lead_id from _seo_plan));
  get diagnostics v_moved = row_count;

  raise notice 'Applied: % user(s) re-pointed.', v_moved;
end $$;

-- -----------------------------------------------------------------------------
-- The report. Last statement in the file, because the editor only shows the
-- final result set. It reads the LIVE reporting lines, so after an apply every
-- roster row should say "ok"; anything else needs a human.
-- -----------------------------------------------------------------------------
select
  p.lead_label                                  as team_lead,
  p.label                                       as roster_name,
  case p.kind
    when 'not_found'     then 'NOT FOUND -- no DD user matches; create their account or put their email in this file, then re-run'
    when 'ambiguous'     then 'AMBIGUOUS -- skipped, ' || p.n || ' users match; put the right email in this file, then re-run'
    when 'is_lead'       then 'SKIPPED -- matched one of the SEO leads; fix the email or name_pat in this file'
    when 'claimed_twice' then 'SKIPPED -- the same user matched two roster names; fix the email or name_pat in this file'
    else case
      when u.manager_user_id = p.lead_id
       and (u.secondary_manager_user_id is null
            or u.secondary_manager_user_id not in (select lead_id from _seo_plan))
        then 'ok -- on ' || p.lead_label || '''s team'
      else 'TO APPLY -- will report to ' || p.lead_label || ' once v_apply is true'
    end
  end                                           as status,
  case
    when p.user_id is null then null
    when p.rk = 1          then 'email'
    else                        'NAME -- check this is the right person'
  end                                           as matched_on,
  p.configured_email,
  u.name                                        as matched_name,
  u.email                                       as matched_email,
  u.role::text                                  as role,
  mgr.name                                      as reports_to_now,
  sec.name                                      as also_reports_to_now,
  case when u.id is null then null else exists (
    select 1 from public.department_members dm
     where dm.user_id = u.id and dm.department_id = 'dep_seo'
  ) end                                         as in_seo_department
from _seo_plan p
left join public.users u   on u.id = p.user_id
left join public.users mgr on mgr.id = u.manager_user_id
left join public.users sec on sec.id = u.secondary_manager_user_id

union all

-- Anyone else who reports to one of the three leads. Listed, never changed.
select
  l.lead_label,
  null,
  'NOT ON ROSTER -- still on ' || l.lead_label || '''s team; left unchanged',
  null,
  null,
  x.name,
  x.email,
  x.role::text,
  mgr.name,
  sec.name,
  exists (
    select 1 from public.department_members dm
     where dm.user_id = x.id and dm.department_id = 'dep_seo'
  )
from (select distinct lead_label, lead_id from _seo_plan) l
join public.users x
  on x.manager_user_id = l.lead_id or x.secondary_manager_user_id = l.lead_id
left join public.users mgr on mgr.id = x.manager_user_id
left join public.users sec on sec.id = x.secondary_manager_user_id
where x.id not in (select user_id from _seo_plan where user_id is not null)

order by team_lead, roster_name nulls last, matched_name;
