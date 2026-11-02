-- Pin a person's task announcements to a Slack channel of their own.
--
-- Task announcements route on the TASK's department: both call sites look up
-- departments.task_channel_id from task.department_id (api/tasks/route.ts and
-- api/tasks/[id]/claim/route.ts). That is right until someone's department is
-- changed for a reason that has nothing to do with Slack -- moving a person
-- onto the Facebook team to pick up the proof/approval flow, say, which is
-- gated purely on the task's department. Their announcements then follow,
-- landing in a channel that has no interest in the work.
--
-- This column breaks that coupling for the one case that needs it, without a
-- name hardcoded in application code: when the task's ASSIGNEE has a channel
-- pinned here, their announcements go there instead of to the department's.
-- NULL -- every user, today -- keeps the existing department routing exactly.
--
-- Deliberately keyed on the assignee, not the creator: these messages are
-- "here is a piece of work and who holds it", so the audience that cares is
-- the holder's team. A task with no assignee (a team-pool task) has no
-- override to consult and falls through to the department, which is also why
-- the inactivity sweep's team-pool digest needs no change -- it only ever
-- posts about unassigned tasks.

alter table public.users
  add column if not exists task_slack_channel_id text;

comment on column public.users.task_slack_channel_id is
  'Slack channel id for task announcements about this person''s work. NULL = route by the task''s department (the default).';
