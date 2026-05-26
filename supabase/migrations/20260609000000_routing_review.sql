-- Routing review surface. Auto-intake already produces draft tasks
-- (is_draft = true) that wait for dept-head approval, but the routing
-- reasoning that led to the suggested assignee was transient. This
-- migration:
--   1. Persists every routing decision into routing_decisions.
--   2. Adds a back-pointer on tasks → routing_decisions.
--   3. Converts the task status enum to text+check and adds 'rejected'
--      so denied drafts can be soft-deleted (kept for audit) instead
--      of dropped from the row entirely.

begin;

create table if not exists public.routing_decisions (
  id text primary key,
  task_id text references public.tasks(id) on delete set null,
  account_id text not null,
  thread_id text not null,
  classifier_output jsonb,
  matched_rule_id text,
  matched_rule_label text,
  ranker_top jsonb,
  routed_via text not null,
  routed_to_user_id text references public.users(id) on delete set null,
  reason text,
  needs_review boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now()
);

create index if not exists routing_decisions_task_idx
  on public.routing_decisions (task_id);
create index if not exists routing_decisions_needs_review_idx
  on public.routing_decisions (created_at desc)
  where needs_review = true and task_id is null;

alter table public.tasks
  add column if not exists routing_decision_id text
    references public.routing_decisions(id) on delete set null;

alter table public.tasks alter column status drop default;
alter table public.tasks alter column status type text using status::text;
alter table public.tasks alter column status set default 'pending';

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('pending', 'in_progress', 'urgent', 'waiting_on_client', 'done', 'rejected'));

commit;
