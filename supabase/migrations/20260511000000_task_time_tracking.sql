-- Task-level time tracking on top of the existing shift clock.
--
-- Each row in time_entries already represents a continuous segment between
-- clock-in and clock-out (or "still on shift" when ended_at is null). To
-- attribute time to a specific task, we add an optional task_id: rows with a
-- task_id count toward that task's actual_hours; rows with task_id null are
-- "general shift time" (admin, breaks-still-clocked-in, no active task).
--
-- The "one open segment per user" partial unique index from the original
-- migration still holds — so starting a task closes the prior segment and
-- opens a new one (the task_id swap is the segmentation mechanism).

alter table time_entries
  add column if not exists task_id text references tasks(id) on delete set null;

create index if not exists time_entries_task_idx
  on time_entries(task_id, started_at desc)
  where task_id is not null;

-- Tasks: actual_hours is now derived from sum(time_entries) by default. The
-- optional override lets users record off-clock work or backfill historical
-- hours without falsifying the time log. NULL = derived; numeric = use as-is.
alter table tasks
  add column if not exists actual_hours_override numeric(6,2);
