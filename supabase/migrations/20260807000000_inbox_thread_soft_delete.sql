-- Soft delete for inbox threads.
--
-- The missive clone is the source of truth for threads and has no delete
-- concept of its own, so — exactly like thread_read_state shadows read state —
-- we shadow deletion here. Nothing is ever removed from the clone: a delete is
-- an INSERT here, a restore is a DELETE of that row. Mail is therefore always
-- recoverable, matching the soft-delete philosophy already used for tasks
-- (see 20260620000000_task_soft_delete.sql).
--
-- Granularity is (thread, account), NOT (thread, user): these are SHARED team
-- inboxes, so deleting a thread out of support@ removes it from that inbox for
-- everyone who can see it — which is what a shared mailbox is expected to do.
-- A thread that landed in several connected accounts (the same message sent to
-- support@ and billing@, say) therefore needs one row per account, which is
-- what lets the UI offer "delete from this inbox" vs "delete from all inboxes".
--
-- thread_snapshot holds just enough of the thread (subject, sender, snippet,
-- timestamp, the account emails it belonged to) to render the Trash list
-- without fanning out a per-thread fetch back to the clone. It is display
-- metadata only — restoring re-reads the live thread from the clone.
create table if not exists public.inbox_thread_deletions (
  thread_id text not null,            -- Missive thread id (no FK; the clone
                                      -- owns the thread itself).
  account_id text not null,           -- Connected account the thread is
                                      -- deleted FROM.
  deleted_at timestamptz not null default now(),
  deleted_by text references public.users(id) on delete set null,
  thread_snapshot jsonb,
  primary key (thread_id, account_id)
);

-- Trash view: "deleted things in these inboxes, newest first".
create index if not exists inbox_thread_deletions_account_idx
  on public.inbox_thread_deletions (account_id, deleted_at desc);

-- Hot path: the thread lists look up deletions for a page of thread ids at a
-- time, so the PK's leading column already serves them; this covers the
-- reverse-chronological sweep used by any future auto-purge job.
create index if not exists inbox_thread_deletions_deleted_at_idx
  on public.inbox_thread_deletions (deleted_at desc);

alter table public.inbox_thread_deletions enable row level security;
