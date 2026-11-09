-- Executive AI Assistant, P5a: measure DD text volumes BEFORE switching DD text triage on.
--
-- HAND-RUN in the Supabase SQL editor. Never run by the app or by Claude. OPTIONAL.
-- READ-ONLY: two SELECTs, nothing is written. The SQL editor shows only the last result
-- grid, so run each statement on its own (select it, then Run):
--   A1  daily text volumes by ET day, the last 28 days: comments (all, 15+ characters, with
--       mention chips), status changes that carry a note, comment lengths, legacy
--       task_messages, submitted EOD/SOD notes and how many carry blockers;
--   A2  population and table sizes: users, who the EOD/SOD ritual expects, clock users,
--       explicit weekly schedules, users without a work timezone, the owner's role,
--       activity_logs and task_messages sizes, project tasks with due dates.
-- What to look for: comments_15plus + status_changes_with_text + eod/sod_with_blockers per
-- day is roughly the number of items the triage reads a day (each run triages at most 200;
-- the $1/day ddtext ceiling caps spend; expected spend is about $1 a month).
-- sod_notes.note_date is each user's own zone, so its day column is approximate.

-- A1. Daily text volumes by ET day, last 28 days
with days as (
  select g::date as d
  from generate_series(((now() at time zone 'America/New_York')::date - 27)::timestamp,
                       ((now() at time zone 'America/New_York')::date)::timestamp,
                       interval '1 day') as g
),
logs as (
  select (created_at at time zone 'America/New_York')::date as d,
         count(*) filter (where action = 'comment') as comments,
         count(*) filter (where action = 'comment' and length(coalesce(detail, '')) >= 15) as comments_15plus,
         count(*) filter (where action = 'comment' and cardinality(mentioned_user_ids) > 0) as comments_with_mentions,
         count(*) filter (where action = 'status_change' and strpos(coalesce(detail, ''), chr(10)) > 0) as status_changes_with_text,
         round(avg(length(detail)) filter (where action = 'comment')) as avg_comment_chars,
         max(length(detail)) filter (where action = 'comment') as max_comment_chars
  from public.activity_logs
  where created_at >= now() - interval '29 days'
  group by 1
),
msgs as (
  select (created_at at time zone 'America/New_York')::date as d, count(*) as task_messages
  from public.task_messages
  where created_at >= now() - interval '29 days'
  group by 1
),
eod as (
  select note_date as d,
         count(*) filter (where submitted_at is not null) as eod_submitted,
         count(*) filter (where submitted_at is not null and length(trim(coalesce(blockers, ''))) > 0) as eod_with_blockers
  from public.eod_notes
  where note_date >= (now() at time zone 'America/New_York')::date - 27
  group by 1
),
sod as (
  select note_date as d,
         count(*) filter (where submitted_at is not null) as sod_submitted,
         count(*) filter (where submitted_at is not null and length(trim(coalesce(blockers, ''))) > 0) as sod_with_blockers
  from public.sod_notes
  where note_date >= (now() at time zone 'America/New_York')::date - 27
  group by 1
)
select days.d as et_day, extract(isodow from days.d) as iso_dow,
       logs.comments, logs.comments_15plus, logs.comments_with_mentions, logs.status_changes_with_text,
       logs.avg_comment_chars, logs.max_comment_chars, msgs.task_messages,
       eod.eod_submitted, eod.eod_with_blockers, sod.sod_submitted, sod.sod_with_blockers
from days
left join logs on logs.d = days.d
left join msgs on msgs.d = days.d
left join eod on eod.d = days.d
left join sod on sod.d = days.d
order by days.d;

-- A2. Population and table sizes
select
  (select count(*) from public.users) as users,
  (select count(*) from public.users u
     where u.daily_prompts_required
        or (u.role <> 'leader' and not u.is_admin and u.daily_prompts_enabled)) as ritual_expected,
  (select count(*) from public.users where clock_enabled) as clock_users,
  (select count(*) from public.users where weekly_schedule <> '{}'::jsonb) as with_weekly_schedule,
  (select count(*) from public.users where work_timezone is null) as without_work_timezone,
  (select role from public.users where lower(trim(email)) = 'mitchell@scaledai.org') as mitchell_role,
  (select count(*) from public.activity_logs) as activity_logs_rows,
  pg_size_pretty(pg_total_relation_size('public.activity_logs')) as activity_logs_size,
  (select count(*) from public.task_messages) as task_messages_rows,
  (select max(created_at) from public.task_messages) as task_messages_newest,
  (select count(*) from public.tasks where project_id is not null) as project_tasks,
  (select count(*) from public.tasks where project_id is not null and due_date is not null) as project_tasks_with_due;
