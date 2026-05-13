-- Link a task back to its Google Calendar event so we can patch /
-- delete the right block when the task moves. Each task gets at most
-- one event on its assignee's calendar; reassignment deletes the
-- old event and creates a fresh one on the new assignee's calendar.

alter table public.tasks
  add column if not exists calendar_event_id text,
  add column if not exists calendar_event_user_id text references public.users(id) on delete set null;

create index if not exists tasks_calendar_event_id_idx
  on public.tasks (calendar_event_id);
