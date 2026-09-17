-- Owner can dismiss a thread from the Scale Room inbox so it never shows there
-- again. This only hides it inside DelegationDoer — it never touches the real
-- Missive mailbox. Keyed by Missive thread id.
create table if not exists inbox_dismissals (
  thread_id text primary key,
  dismissed_by text,
  dismissed_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
