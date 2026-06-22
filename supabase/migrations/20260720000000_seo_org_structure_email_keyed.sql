-- Re-wire the SEO reporting tree to the intended structure, keyed by EMAIL.
--
-- Why email, not name: the original org seed (20260528000001_seed_org_structure)
-- matched by display name, but the live names have since drifted (e.g.
-- emily@scaledai.org now displays as "Komal", sophia@scaledai.org as "Nabil"),
-- so name-keyed updates silently miss / mis-target. Email is the durable unique
-- key (users.email is UNIQUE). A typo'd / absent email updates zero rows — no bad
-- data gets written — same safety property the name-keyed seed relied on.
--
-- Target structure (co-lead model — Farez + Tabrez both lead the SAME pod, so
-- it renders under both via secondary_manager_user_id; the grandchildren follow
-- automatically through the OrgChart recursion and need NO secondary):
--
--   Sam (sam@scaledai.org)  — DEPARTMENT HEAD
--   ├── Farez  (farezomair1996@gmail.com)
--   └── Tabrez (tabrez@scaledai.org)
--           ├── Bismah    (bella@scaledai.org)  → Komal (emily@scaledai.org),    Nabil (sophia@scaledai.org)
--           ├── Saifullah (steve@scaledai.org)  → Fana  (fanaanwar01@gmail.com), Mustajab (daniel@scaledai.org)
--           └── Samir G   (samir@scaledai.org)  → Abeer (aiden@scaledai.org),    Abdullah (gub.masud@gmail.com)
--
-- Idempotent — re-running re-applies the same values. The Leader Console →
-- People tab remains the source of truth going forward; this is here so the
-- structure is correct the moment it deploys.

-- ============================================================
-- STEP 0 -- Diagnostic. Emits NOTICEs; mutates nothing. Review the
-- output before trusting the rest of the run. The 12 canonical emails
-- should each resolve to exactly one row; the "extras" list is exactly
-- who Step 2 will unlink from SEO (Gul Afroz + any duplicate rows).
-- ============================================================
do $$
declare
  resolved int;
  extras   text;
begin
  select count(*) into resolved
    from public.users
   where lower(email) in (
     'sam@scaledai.org','farezomair1996@gmail.com','tabrez@scaledai.org',
     'bella@scaledai.org','steve@scaledai.org','samir@scaledai.org',
     'emily@scaledai.org','sophia@scaledai.org','fanaanwar01@gmail.com',
     'daniel@scaledai.org','aiden@scaledai.org','gub.masud@gmail.com');
  raise notice 'Canonical SEO emails resolved: % of 12 (expect 12).', resolved;

  select string_agg(format('%s <%s> [%s]', u.name, u.email, u.role), ', ')
    into extras
    from public.users u
    join public.department_members dm on dm.user_id = u.id
    join public.departments d on d.id = dm.department_id
   where lower(d.name) = 'seo'
     and lower(u.email) not in (
       'sam@scaledai.org','farezomair1996@gmail.com','tabrez@scaledai.org',
       'bella@scaledai.org','steve@scaledai.org','samir@scaledai.org',
       'emily@scaledai.org','sophia@scaledai.org','fanaanwar01@gmail.com',
       'daniel@scaledai.org','aiden@scaledai.org','gub.masud@gmail.com');
  raise notice 'SEO members to be UNLINKED (kept as accounts): %', coalesce(extras, '(none)');
end $$;

-- ============================================================
-- STEP 1 -- Set roles, department membership, and reporting links.
-- ============================================================

-- Sam leads SEO.
update public.users
   set role = 'department_head'
 where lower(email) = 'sam@scaledai.org' and role <> 'department_head';

-- Everyone else in the pod must be a plain worker, else a stray
-- department_head among them would render as a second root in the chart.
update public.users
   set role = 'worker'
 where role <> 'worker'
   and lower(email) in (
     'farezomair1996@gmail.com','tabrez@scaledai.org',
     'bella@scaledai.org','steve@scaledai.org','samir@scaledai.org',
     'emily@scaledai.org','sophia@scaledai.org','fanaanwar01@gmail.com',
     'daniel@scaledai.org','aiden@scaledai.org','gub.masud@gmail.com');

-- Ensure all 12 are members of the SEO department (buildSubtrees filters by
-- department membership, so a missing membership would drop the node).
insert into public.department_members (user_id, department_id)
select u.id, d.id
  from public.users u, public.departments d
 where lower(d.name) = 'seo'
   and lower(u.email) in (
     'sam@scaledai.org','farezomair1996@gmail.com','tabrez@scaledai.org',
     'bella@scaledai.org','steve@scaledai.org','samir@scaledai.org',
     'emily@scaledai.org','sophia@scaledai.org','fanaanwar01@gmail.com',
     'daniel@scaledai.org','aiden@scaledai.org','gub.masud@gmail.com')
on conflict do nothing;

-- Tier 1: Farez + Tabrez report to Sam (no secondary).
update public.users
   set manager_user_id = (select id from public.users where lower(email) = 'sam@scaledai.org' limit 1),
       secondary_manager_user_id = null
 where lower(email) in ('farezomair1996@gmail.com','tabrez@scaledai.org');

-- Tier 2 (shared pod): Bismah / Saifullah / Samir G report to Farez (primary)
-- AND Tabrez (secondary). The check constraints (secondary <> id, secondary <>
-- manager) are satisfied: primary=Farez, secondary=Tabrez, both distinct.
update public.users
   set manager_user_id = (select id from public.users where lower(email) = 'farezomair1996@gmail.com' limit 1),
       secondary_manager_user_id = (select id from public.users where lower(email) = 'tabrez@scaledai.org' limit 1)
 where lower(email) in ('bella@scaledai.org','steve@scaledai.org','samir@scaledai.org');

-- Tier 3 (no secondary needed — the recursion mirrors them under both co-leads):
--   Komal, Nabil  -> Bismah
update public.users
   set manager_user_id = (select id from public.users where lower(email) = 'bella@scaledai.org' limit 1),
       secondary_manager_user_id = null
 where lower(email) in ('emily@scaledai.org','sophia@scaledai.org');

--   Fana, Mustajab -> Saifullah
update public.users
   set manager_user_id = (select id from public.users where lower(email) = 'steve@scaledai.org' limit 1),
       secondary_manager_user_id = null
 where lower(email) in ('fanaanwar01@gmail.com','daniel@scaledai.org');

--   Abeer, Abdullah -> Samir G
update public.users
   set manager_user_id = (select id from public.users where lower(email) = 'samir@scaledai.org' limit 1),
       secondary_manager_user_id = null
 where lower(email) in ('aiden@scaledai.org','gub.masud@gmail.com');

-- ============================================================
-- STEP 2 -- Unlink extras (e.g. Gul Afroz + duplicate rows), KEEP accounts.
-- Removing the SEO membership drops them from the SEO column without
-- deleting the user (reversible by re-adding membership). Also null any of
-- their reporting links that point at the canonical 12 so no dangling
-- relationship lingers.
-- ============================================================
update public.users
   set manager_user_id = null,
       secondary_manager_user_id = null
 where lower(email) not in (
         'sam@scaledai.org','farezomair1996@gmail.com','tabrez@scaledai.org',
         'bella@scaledai.org','steve@scaledai.org','samir@scaledai.org',
         'emily@scaledai.org','sophia@scaledai.org','fanaanwar01@gmail.com',
         'daniel@scaledai.org','aiden@scaledai.org','gub.masud@gmail.com')
   and (
     manager_user_id in (
       select id from public.users where lower(email) in (
         'sam@scaledai.org','farezomair1996@gmail.com','tabrez@scaledai.org',
         'bella@scaledai.org','steve@scaledai.org','samir@scaledai.org'))
     or secondary_manager_user_id in (
       select id from public.users where lower(email) in (
         'farezomair1996@gmail.com','tabrez@scaledai.org')));

delete from public.department_members dm
 using public.departments d
 where dm.department_id = d.id
   and lower(d.name) = 'seo'
   and dm.user_id not in (
     select id from public.users where lower(email) in (
       'sam@scaledai.org','farezomair1996@gmail.com','tabrez@scaledai.org',
       'bella@scaledai.org','steve@scaledai.org','samir@scaledai.org',
       'emily@scaledai.org','sophia@scaledai.org','fanaanwar01@gmail.com',
       'daniel@scaledai.org','aiden@scaledai.org','gub.masud@gmail.com'));
