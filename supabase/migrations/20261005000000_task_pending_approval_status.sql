-- New task status for the Facebook proofing workflow: when an FB-team member
-- completes an FB task it goes to "pending_approval" (not "done") until a manager
-- (FB department_head) approves it.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status = any (array['pending','in_progress','urgent','waiting_on_client','done','rejected','pending_approval']));
