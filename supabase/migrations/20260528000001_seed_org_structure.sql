-- One-off backfill that wires the live workspace's reporting structure
-- to match the org chart Mitchell sketched (SEO team-lead tree, Website
-- two-team tree, Marketing handover). Idempotent — re-running just
-- re-applies the same values. The Leader Console → People tab remains
-- the source of truth going forward; this is here so the structure is
-- live the moment the feature deploys.
--
-- Name-keyed lookups intentionally: in this workspace these names are
-- unique. If a name doesn't match (typo, future rename) the update
-- silently affects zero rows — no bad data gets written, and the picker
-- in the UI can fix it.

-- ============================================================
-- Marketing: Talha leads it now; Mujtaba steps out of Marketing
-- (he stays in Website where he's still the head).
-- ============================================================
update users
  set role = 'department_head'
  where name = 'Talha Ali' and role <> 'department_head';

delete from department_members dm
  using users u, departments d
  where dm.user_id = u.id
    and dm.department_id = d.id
    and u.name = 'Mujtaba'
    and lower(d.name) = 'marketing';

-- ============================================================
-- SEO team-lead tree under Sam (the existing dept head)
--
--   Sam
--   ├── Tabrez Khan
--   └── Farez Khan
--       ├── Samir G ── Mustajab Khan
--       ├── Saifullah ── Nabil
--       └── Bismah
--           ├── Gul Afroz
--           └── Emily Carter   (the "Komal" placeholder in the mockup)
-- ============================================================
update users
  set manager_user_id = (select id from users where name = 'Sam' limit 1)
  where name in ('Tabrez Khan', 'Farez Khan');

update users
  set manager_user_id = (select id from users where name = 'Farez Khan' limit 1)
  where name in ('Samir G', 'Saifullah', 'Bismah');

update users
  set manager_user_id = (select id from users where name = 'Samir G' limit 1)
  where name = 'Mustajab Khan';

update users
  set manager_user_id = (select id from users where name = 'Saifullah' limit 1)
  where name = 'Nabil';

update users
  set manager_user_id = (select id from users where name = 'Bismah' limit 1)
  where name in ('Gul Afroz', 'Emily Carter');

-- ============================================================
-- Website two-team tree under Mujtaba
--
--   Mujtaba
--   ├── Aaraiz ── Sofia
--   └── Elaine ── Leizel
-- ============================================================
update users
  set manager_user_id = (select id from users where name = 'Mujtaba' limit 1)
  where name in ('Aaraiz', 'Elaine');

-- Mockup says "Sophia"; live workspace spells it "Sofia". Match both
-- so this still wires up if the spelling gets normalized either way.
update users
  set manager_user_id = (select id from users where name = 'Aaraiz' limit 1)
  where name in ('Sofia', 'Sophia');

update users
  set manager_user_id = (select id from users where name = 'Elaine' limit 1)
  where name = 'Leizel';
