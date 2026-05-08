-- Per-user, per-tag skill profile. Two signals merged into one row:
--   * `manual_level` — admin-set baseline (0-5). Captures what the team
--     knows about each person before any task history exists.
--   * `auto_score`   — accumulated score from completed tasks tagged with
--     this skill. Each completion adds points weighted by how the actual
--     hours compared to the estimate (faster = more credit).
--
-- The combined score the delegation engine uses is:
--   manual_level * 6 + auto_score
--
-- so a manual L5 (=30 base points) is roughly equivalent to ~30 perfectly
-- estimated completions of that tag.
create table if not exists user_skills (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  tag text not null,
  manual_level integer not null default 0 check (manual_level between 0 and 5),
  auto_score numeric not null default 0,
  task_count integer not null default 0,
  last_practiced_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, tag)
);

create index if not exists user_skills_user_idx on user_skills(user_id);
create index if not exists user_skills_tag_idx on user_skills(tag);
