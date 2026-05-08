-- Handoff history, per-task threaded messages, and per-user presence state.
--
-- Handoff history: every time a task changes assignee we drop a row here so
-- the CEO can see "task X spent 8 hours with Shaheer, then 1 hour with
-- Alizeh." Each row also captures the "stage" the outgoing person was on
-- (free-text, e.g. "design", "deploy") so bottleneck charts can group by
-- the kind of work each person was doing.
--
-- Messages: a thin per-task chat thread, separate from activity_logs so
-- the noisy status-change events don't bury conversations.
--
-- Presence: tri-state user mode driven by the desktop widget. "focus"
-- (do not interrupt), "eating" (away briefly), "away" (out for the day),
-- and the default null = "available".

create table if not exists task_handoffs (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  from_user_id text references users(id) on delete set null,
  to_user_id   text references users(id) on delete set null,
  -- Free-text stage description supplied by the handing-off user; e.g.
  -- "wireframes done, ready for build" or "design". Lets us group the
  -- bottleneck chart by stage instead of just by person.
  stage text,
  reason text,
  -- Duration the outgoing assignee held the task before this handoff,
  -- materialized at write time so analytics queries don't have to do
  -- window-lag joins. Computed from the previous handoff's created_at
  -- (or the task's created_at if this is the first handoff).
  held_minutes integer,
  created_at timestamptz not null default now()
);

create index if not exists task_handoffs_task_idx on task_handoffs(task_id, created_at);
create index if not exists task_handoffs_to_user_idx on task_handoffs(to_user_id);
create index if not exists task_handoffs_from_user_idx on task_handoffs(from_user_id);


create table if not exists task_messages (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  user_id text references users(id) on delete set null,
  body text not null,
  -- Optional image attachment (uses the same upload bucket as activity log
  -- attachments — no separate storage path needed).
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists task_messages_task_idx on task_messages(task_id, created_at);


-- Per-user presence. Lives on users so a single GET hydrates everyone for
-- the sidebar dot. Nullable = available; constrained to known states.
alter table users
  add column if not exists presence text
    check (presence in ('focus', 'eating', 'away', 'available') or presence is null),
  add column if not exists presence_updated_at timestamptz;
