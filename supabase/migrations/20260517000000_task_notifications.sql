-- Per-user notifications attached to a task: @mentions in the
-- conversation stream + "notify teammates" pings. The widget polls
-- these so a user gets the alarm even when they're not the assignee.
create table if not exists task_notifications (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  from_user_id text references users(id) on delete set null,
  -- "mention" = @<name> inside a comment; "notified" = explicit
  -- Notify-teammates broadcast.
  kind text not null check (kind in ('mention', 'notified')),
  -- Optional human note: the comment text or the FYI message.
  note text,
  created_at timestamptz not null default now(),
  -- Cleared by the widget once the user has acknowledged the alert.
  seen_at timestamptz
);

create index if not exists task_notifications_user_unseen
  on task_notifications (user_id, created_at desc)
  where seen_at is null;

create index if not exists task_notifications_task_idx
  on task_notifications (task_id, created_at desc);
