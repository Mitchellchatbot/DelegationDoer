-- Per-user "Selected inboxes" set. Each user can cherry-pick a subset of
-- the inboxes they're allowed to see and view them combined under the
-- Smart → "Selected inboxes" tab. Stored server-side (not localStorage)
-- so the curated view follows the user across devices/browsers.
--
-- Like inbox_assignments / inbox_space_accounts, the Missive account id is
-- a uuid in the clone's schema — we keep it as text here. Writes go through
-- the service-role client (RLS enabled, no row policies, matching the other
-- inbox tables); the API gates by session + visibility before writing.

create table if not exists public.user_selected_inboxes (
  user_id            text not null references public.users(id) on delete cascade,
  missive_account_id text not null,
  created_at         timestamptz not null default now(),
  primary key (user_id, missive_account_id)
);

create index if not exists user_selected_inboxes_user_idx
  on public.user_selected_inboxes (user_id);

alter table public.user_selected_inboxes enable row level security;
