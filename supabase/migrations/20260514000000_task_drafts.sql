-- AI-generated tasks from email intake land as drafts that the relevant
-- department head approves before the task goes live. The dept head can
-- still edit the assignee / priority / etc. before approving.
--
-- Approve = flip is_draft to false (task becomes a normal pending task).
-- Reject  = delete the row.

alter table public.tasks
  add column if not exists is_draft boolean not null default false;

-- Partial index: drafts are a small slice of tasks, so a partial index
-- keeps the "drafts in my dept" query cheap without bloating writes on
-- the much-more-common active-task path.
create index if not exists tasks_is_draft_idx
  on public.tasks (department_id)
  where is_draft = true;
