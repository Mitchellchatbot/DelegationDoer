-- Per-department "new task" Slack channel: when a task is created
-- with a department, POST /api/tasks fires a one-line announcement
-- into this channel. Separate from slack_channel_id (the EOD digest
-- target) so a team can route daily recaps to #team-eod while the
-- in-flight task firehose goes to #website-to-do.
alter table public.departments
  add column if not exists task_channel_id text;

-- Workspace-wide channel config. Single-row singleton (id='workspace')
-- keeps the schema flat without needing an enum or JSON blob.
create table if not exists public.workspace_settings (
  id text primary key default 'workspace',
  -- Org-wide channel (Scaled Team) — receives the 7pm EST EOD recap
  -- + anything else we want everyone to see in one place.
  scaled_team_channel_id text,
  -- Channel that gets the daily 7pm EST EOD recap. Defaults to the
  -- scaled team channel when null. Stored separately so the user can
  -- split them later without a schema migration.
  eod_recap_channel_id text,
  -- Timestamp of the last successful EOD recap post, used to skip
  -- re-runs if the cron fires twice in one day (Vercel is at-least-once).
  last_eod_recap_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Seed the singleton row with the Scaled Team channel id provided
-- by the operator. Idempotent.
insert into public.workspace_settings (id, scaled_team_channel_id)
values ('workspace', 'C080JJL5GRH')
on conflict (id) do update
  set scaled_team_channel_id = excluded.scaled_team_channel_id;
