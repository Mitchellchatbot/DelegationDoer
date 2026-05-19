-- Optional reporting line that lets a worker report to another worker
-- inside the same department (e.g. a team lead under the dept head).
-- The org chart used to be a flat list of workers under the head; this
-- column lets us render the nested team-lead tree from the design mock.
--
-- NULL = "no explicit manager" → the chart falls back to the dept head
-- for that worker, preserving every existing render.
-- ON DELETE SET NULL = removing a manager doesn't orphan their reports;
-- they just float back up to the dept head until reassigned.
-- users.id is `text` in this project's schema (see 20260505000000_init.sql),
-- so the FK column must match. A uuid here trips a 42804 incompatible-types
-- error at constraint creation.
alter table users
  add column if not exists manager_user_id text
    references users(id) on delete set null;

-- Belt-and-suspenders: a user can't be their own manager. UI + API both
-- guard against this too, but the DB is the last line of defense.
alter table users
  drop constraint if exists users_manager_not_self;
alter table users
  add constraint users_manager_not_self
    check (manager_user_id is null or manager_user_id <> id);

create index if not exists users_manager_user_id_idx
  on users(manager_user_id)
  where manager_user_id is not null;
