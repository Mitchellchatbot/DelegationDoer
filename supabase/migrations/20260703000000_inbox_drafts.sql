-- Per-user inbox drafts (inline replies + new-message compose). DD-owned,
-- keyed by the DD user_id. We do NOT use missiveclone's /api/drafts: it keys
-- drafts on the authenticated missive user, and DD talks to missive through a
-- single shared service token, so proxying it would make every DD user
-- share/overwrite one draft per thread. Sending still goes through missive;
-- this table only holds the unsent working copy.
--
-- Distinct from email_drafts (the client-email approval queue).
--
--   reply draft    -> thread_id NOT NULL (one per user per thread)
--   compose draft  -> thread_id NULL     (each gets its own id)

create table if not exists inbox_drafts (
  id          text primary key,
  -- Owner. Drafts are personal; cascade-delete with the user.
  user_id     text not null references public.users(id) on delete cascade,
  -- Missive account to send FROM. nullable (a compose draft may be started
  -- before a from-mailbox is picked). No FK — the clone owns the account.
  account_id  text,
  -- Missive thread for replies; NULL for new-message compose drafts. No FK —
  -- the clone is the source of truth for the thread itself.
  thread_id   text,
  -- Recipients. Optional arrays; bcc only meaningful for compose.
  to_addrs    text[] not null default '{}',
  cc_addrs    text[] not null default '{}',
  bcc_addrs   text[] not null default '{}',
  subject     text,
  body_text   text not null default '',
  body_html   text,
  -- Attachment metadata (TaskMedia[] — uploaded URLs, not bytes). Forwarded
  -- to missive as multipart files[] at send time, same as the composers do.
  attachments jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One reply draft per (user, thread). Partial so compose drafts (thread_id
-- NULL) never collide and the autosave upsert can target it via ON CONFLICT.
create unique index if not exists inbox_drafts_user_thread_uidx
  on inbox_drafts(user_id, thread_id) where thread_id is not null;

-- Drafts-folder listing: caller's drafts, newest first.
create index if not exists inbox_drafts_user_idx
  on inbox_drafts(user_id, updated_at desc);

create or replace function public.set_inbox_drafts_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists inbox_drafts_set_updated_at on inbox_drafts;
create trigger inbox_drafts_set_updated_at
  before update on inbox_drafts
  for each row execute function public.set_inbox_drafts_updated_at();

-- Writes go through service_role (server routes); enable RLS with no policy
-- so anon/authed clients can't read other users' drafts directly.
alter table inbox_drafts enable row level security;
