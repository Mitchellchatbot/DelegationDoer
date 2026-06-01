-- Email notifications: per-user pings when a new inbound email lands
-- in an inbox they've opted into. Two tables:
--
--   user_email_notification_prefs — which Missive accounts each user
--     wants notifications for. Composite PK (user_id, missive_account_id)
--     mirrors the shape of inbox_assignments. A row with enabled=false
--     means the user explicitly opted out (vs no row, which means they
--     haven't gone through onboarding yet).
--
--   email_notifications — persisted notification rows. Webhook writes
--     one row per user-with-enabled-prefs when message:new fires. The
--     home dashboard reads from here so a user who was offline still
--     sees recent emails in the card on next visit. seen_at flips to
--     now() on POST /email-notifications/mark-seen.
--
-- Bonus: users.email_notifications_onboarded — flips to true when the
-- user finishes the modal walkthrough. Used to decide whether the home
-- card shows the empty state with the CTA or the live list.

create table if not exists public.user_email_notification_prefs (
  user_id             text not null references public.users(id) on delete cascade,
  missive_account_id  text not null,
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (user_id, missive_account_id)
);

create index if not exists user_email_notif_prefs_user_idx
  on public.user_email_notification_prefs (user_id);
create index if not exists user_email_notif_prefs_account_enabled_idx
  on public.user_email_notification_prefs (missive_account_id, enabled);

alter table public.user_email_notification_prefs enable row level security;

create table if not exists public.email_notifications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             text not null references public.users(id) on delete cascade,
  missive_account_id  text not null,
  thread_id           text not null,
  message_id          text,
  subject             text,
  from_name           text,
  from_email          text,
  preview             text,
  received_at         timestamptz not null default now(),
  seen_at             timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists email_notifications_user_recent_idx
  on public.email_notifications (user_id, received_at desc);
create index if not exists email_notifications_user_unseen_idx
  on public.email_notifications (user_id, seen_at) where seen_at is null;
-- Dedup guard: don't double-write the same (user, message) if the
-- webhook fires twice. message_id is nullable but in practice every
-- inbound message has one; if it's missing we let the row through.
create unique index if not exists email_notifications_user_message_uniq
  on public.email_notifications (user_id, message_id) where message_id is not null;

alter table public.email_notifications enable row level security;

alter table public.users
  add column if not exists email_notifications_onboarded boolean not null default false;
