-- Support notifications: per-user pings when a new inbound customer-support
-- SMS lands in the Customer Support tab (categories customer_support or
-- uncertain). Mirrors email_notifications, minus a prefs table: the audience
-- isn't opt-in, it's role-derived (canSeeCustomerSupport — Mujtaba + admins),
-- so support-intake fans out one row per support-visible user on ingest.
--
-- The Electron widget polls /api/support-notifications every 15s, chimes +
-- fires an OS notification for fresh rows, and shows a SupportAlert bubble.
-- seen_at flips to now() on POST /support-notifications/mark-seen.

create table if not exists public.support_notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null references public.users(id) on delete cascade,
  conversation_id  uuid not null references public.support_conversations(id) on delete cascade,
  message_id       text not null,
  contact_name     text,
  phone            text,
  preview          text,
  category         text,
  received_at      timestamptz not null default now(),
  seen_at          timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists support_notifications_user_recent_idx
  on public.support_notifications (user_id, received_at desc);
create index if not exists support_notifications_user_unseen_idx
  on public.support_notifications (user_id, seen_at) where seen_at is null;
-- Dedup guard: one row per (user, blooio message) even if the webhook and the
-- poll cron both ingest the same inbound. Mirrors
-- email_notifications_user_message_uniq.
create unique index if not exists support_notifications_user_message_uniq
  on public.support_notifications (user_id, message_id);

alter table public.support_notifications enable row level security;
