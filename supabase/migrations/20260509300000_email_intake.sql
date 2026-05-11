-- Email auto-intake. The cron route polls Missive for new threads, runs
-- them through the routing-rules → ranker → AI fallback pipeline, and
-- creates a task per new thread. These tables track which threads we've
-- already handled (so the cron is idempotent) and which inboxes opt in.

create table if not exists email_intake_log (
  thread_id text primary key,         -- Missive thread id
  account_id text not null,           -- which inbox it came from
  task_id text references tasks(id) on delete set null,
  routed_via text not null,           -- 'rule:<id>' | 'ranker' | 'ai-fallback' | 'manual'
  routed_to_user_id text references users(id) on delete set null,
  processed_at timestamptz not null default now()
);

create index if not exists email_intake_log_account_idx on email_intake_log(account_id, processed_at desc);

-- Per-inbox auto-intake toggle. Off by default — flipping it on opts a
-- specific Missive account into the cron's polling loop. The /inboxes/manage
-- page will surface this as a checkbox column.
create table if not exists missive_account_settings (
  account_id text primary key,
  auto_intake_enabled boolean not null default false,
  -- Watermark — the cron only processes threads created/updated after
  -- this timestamp, so it doesn't have to walk the entire history each
  -- run. Bumped on every successful intake.
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
