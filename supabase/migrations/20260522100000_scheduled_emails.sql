-- Emails the user picked "Send later" on. The cron at
-- /api/cron/scheduled-emails picks up rows whose scheduled_for is in
-- the past and dispatches them via the Missive clone, then flips the
-- status to 'sent' (or 'failed' with the error captured).
create table if not exists scheduled_emails (
  id text primary key,
  thread_id text not null,
  account_id text not null,
  user_id text not null references users(id) on delete cascade,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text,
  body_text text not null,
  body_html text,
  in_reply_to text,
  scheduled_for timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'canceled')),
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists scheduled_emails_due_idx
  on scheduled_emails (status, scheduled_for);
create index if not exists scheduled_emails_user_idx
  on scheduled_emails (user_id, status);
