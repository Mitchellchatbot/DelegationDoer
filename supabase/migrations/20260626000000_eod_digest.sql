-- EOD digest emails — accumulate per-client end-of-day reports into one
-- approval-queue email draft, with bookkeeping so each completed task
-- only ever shows up in ONE outbound client email.
--
-- Two pieces:
--
--   1. tasks.reported_to_client_at — stamped by the email-drafts
--      approve route the moment a draft of kind='eod_digest' moves to
--      status='sent'. Future digest builds exclude any task whose
--      stamp is non-null, so we don't tell the client about the same
--      thing twice.
--
--   2. email_draft_tasks (draft_id, task_id) — many-to-many link of
--      which tasks each draft references. Populated when the digest
--      builder upserts a draft; read by the approve route to know
--      which task rows to stamp on send. CASCADE on draft delete so
--      a cleaned-up draft doesn't leave orphan links; ON DELETE for
--      task_id is a no-op because we soft-delete tasks (the row
--      sticks around).

alter table public.tasks
  add column if not exists reported_to_client_at timestamptz;

-- Partial index — we only ever query "tasks NOT yet reported", so the
-- nulls are the hot path. Keeps the index small.
create index if not exists tasks_reported_to_client_null_idx
  on public.tasks (client_name)
  where reported_to_client_at is null;

create table if not exists public.email_draft_tasks (
  draft_id   text not null references public.email_drafts(id) on delete cascade,
  task_id    text not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (draft_id, task_id)
);

create index if not exists email_draft_tasks_task_idx
  on public.email_draft_tasks (task_id);

alter table public.email_draft_tasks enable row level security;
