-- Auto-reply support for email_drafts.
-- When an inbound email lands and auto-intake creates a draft task,
-- we also draft a polite acknowledgement reply via Claude and stash
-- it here. The /approvals queue picks it up like any other draft.
-- On approve, the route detects kind='auto_reply' + source_thread_id
-- and dispatches via sendReply (reply on the existing thread) instead
-- of composeNewThread (which would start a new conversation).

alter table public.email_drafts
  drop constraint if exists email_drafts_kind_check;

alter table public.email_drafts
  add constraint email_drafts_kind_check
  check (kind in ('client_update', 'content_plan', 'custom', 'auto_reply'));

-- source_thread_id: the inbound Missive thread that triggered this
-- draft. Distinct from missive_thread_id, which gets populated AFTER
-- a successful send (with the SENT thread id). For replies they'll
-- be the same, but keeping them separate makes the intent obvious
-- and simplifies the approve-route branch.
alter table public.email_drafts
  add column if not exists source_thread_id text;

create index if not exists email_drafts_source_thread_idx
  on public.email_drafts (source_thread_id)
  where source_thread_id is not null;
