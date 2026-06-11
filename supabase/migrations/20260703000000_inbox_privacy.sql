-- Private inboxes — "the boss's email container."
--
-- By default a leader/admin sees every connected inbox. A row here marks
-- one account as PRIVATE: only its owner (a DelegationDoer user) may see
-- it, and everyone else — including other leaders/admins — is excluded,
-- no matter their role or any inbox_assignment. Enforced centrally in
-- visibleAccountIdsFor (src/lib/inbox-access.ts), so every inbox surface
-- (list, threads, compose, reply, attachments, AI tools, notifications)
-- inherits the restriction.
--
-- Presence of a row = private. owner_user_id is who's allowed to see it
-- (nullable so the row survives a user deletion; a null owner means the
-- inbox is private to nobody-but-future-reassignment, effectively hidden
-- from all until re-owned — the UI always sets an owner).

create table if not exists public.inbox_privacy (
  missive_account_id text primary key,
  owner_user_id      text references public.users(id) on delete set null,
  created_by         text references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists inbox_privacy_owner_idx
  on public.inbox_privacy (owner_user_id);
