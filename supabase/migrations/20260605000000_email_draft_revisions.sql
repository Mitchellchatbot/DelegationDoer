-- Collaborative approval workflow on email_drafts. Adds:
--   1. A non-terminal 'needs_revision' status so an approver can send
--      a draft back for changes without rejecting it outright. The
--      author edits and re-submits → back to 'pending', preserving
--      every prior comment.
--   2. revision_count — incremented each time the author resubmits,
--      so the UI can flag "v3 of this draft" etc.
--   3. email_draft_events — append-only timeline. Captures every
--      action (comment, revision request, resubmit, approve, reject,
--      send, send failure, edit) with actor + body + timestamp so
--      the approvals page can render a full history.

-- 1. Widen the status check constraint.
alter table public.email_drafts
  drop constraint if exists email_drafts_status_check;

alter table public.email_drafts
  add constraint email_drafts_status_check
  check (status in ('pending', 'needs_revision', 'approved', 'rejected', 'sent', 'failed'));

-- 2. Track resubmission count for the UI.
alter table public.email_drafts
  add column if not exists revision_count int not null default 0;

-- 3. Event log. Type covers every action that can show up on the
--    approval timeline. body is free-text (comment / revision note /
--    rejection note / etc.); metadata is reserved for structured
--    extras (e.g. revision_count snapshot) without schema churn.
create table if not exists public.email_draft_events (
  id           text primary key,
  draft_id     text not null references public.email_drafts(id) on delete cascade,
  actor_id     text references public.users(id) on delete set null,
  type         text not null check (type in (
    'submitted',
    'comment',
    'revision_requested',
    'resubmitted',
    'edited',
    'approved',
    'rejected',
    'sent',
    'send_failed'
  )),
  body         text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists email_draft_events_draft_idx
  on public.email_draft_events(draft_id, created_at asc);
create index if not exists email_draft_events_actor_idx
  on public.email_draft_events(actor_id, created_at desc);
