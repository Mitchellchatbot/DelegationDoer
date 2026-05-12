-- Structured stages on each project.
--
-- A project is an ordered list of stages (scope → architecture →
-- frontend → completed for the software template). Each stage carries
-- its own rich documentation (an "is" bullet list, an "isn't" bullet
-- list, free-form notes, and uploaded image URLs for diagrams/mockups)
-- plus a status (locked / active / done) used to gate task delegation.

create table if not exists project_stages (
  id          text primary key,
  project_id  text not null references projects(id) on delete cascade,
  position    integer not null,
  name        text not null,
  -- Free-form kind label so we can show different icons / template
  -- families later (scope, architecture, frontend, backend, completed,
  -- custom). Not an enum so per-department templates can introduce new
  -- kinds without a migration.
  kind        text not null default 'custom',
  status      text not null default 'locked' check (status in ('locked','active','done')),
  is_it       text[] not null default '{}',
  is_not      text[] not null default '{}',
  image_urls  text[] not null default '{}',
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, position)
);

create index if not exists project_stages_project_idx
  on project_stages(project_id, position);

-- Tie each task to the stage it satisfies. Stage deletion releases
-- the task (set null) rather than cascading — losing the task row
-- would lose history.
alter table tasks
  add column if not exists stage_id text references project_stages(id) on delete set null;

-- Ordering inside a stage. parallel_group = 0 (or NULL) means "fire
-- with the next available batch"; tasks sharing a parallel_group fire
-- simultaneously and the next group only fires when the current group
-- is fully done. position breaks ties for display order.
alter table tasks
  add column if not exists parallel_group integer;

alter table tasks
  add column if not exists stage_position integer;

create index if not exists tasks_stage_idx
  on tasks(stage_id, parallel_group, stage_position);
