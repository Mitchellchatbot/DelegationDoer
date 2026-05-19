-- Second reporting line: when a worker has two team leads sharing the
-- same pod (e.g. SEO's Tabrez + Farez co-leading Samir/Saif/Bismah),
-- secondary_manager_user_id captures the second one. The OrgChart
-- renders the child node under BOTH managers — the duplicate render
-- makes the dual-reporting relationship explicit visually.
--
-- NULL = no secondary manager (the common case). The primary
-- manager_user_id remains the source of truth for "who is X's
-- principal manager." The secondary is purely additive in the chart.
alter table users
  add column if not exists secondary_manager_user_id text
    references users(id) on delete set null;

alter table users
  drop constraint if exists users_secondary_manager_not_self;
alter table users
  add constraint users_secondary_manager_not_self
    check (secondary_manager_user_id is null or secondary_manager_user_id <> id);

-- Disallow setting the same person as both primary and secondary —
-- that would render the worker twice under the same parent.
alter table users
  drop constraint if exists users_secondary_manager_not_primary;
alter table users
  add constraint users_secondary_manager_not_primary
    check (
      secondary_manager_user_id is null
      or manager_user_id is null
      or secondary_manager_user_id <> manager_user_id
    );

create index if not exists users_secondary_manager_user_id_idx
  on users(secondary_manager_user_id)
  where secondary_manager_user_id is not null;

-- Backfill for the SEO pod: Samir G, Saifullah, Bismah report to
-- Farez (primary, already set) AND Tabrez (secondary, set here).
update users
  set secondary_manager_user_id = (select id from users where name = 'Tabrez Khan' limit 1)
  where name in ('Samir G', 'Saifullah', 'Bismah');
