-- Per-message satisfaction scoring. Replaces the legacy gpt-4o-mini
-- sentiment cron with a Claude Haiku scorer that grades every message
-- (inbound + outbound) in a client thread on a 0-100 scale. Storage
-- is per-message so the median across a client's full mail history
-- is a cheap aggregate; per-message reasons let a leader audit *why*
-- a client landed at "shaky".
--
-- Scoring is binary-leaning per product spec:
--   90-100 = clearly satisfied / positive ("great work", "perfect")
--   70-85  = neutral / transactional / routine
--   30-55  = dissatisfied ("this isn't right", repeated follow-ups)
--   0-25   = hostile / churn-shaped language
-- The model is instructed to prefer the polar values; ~75 is reserved
-- for genuinely neutral content. Median over a client's messages →
-- health label via lib/client-health.ts:scoreToLabel.

create table if not exists public.email_satisfaction_scores (
  -- Missive message id is the natural PK; an upsert path lets us
  -- re-score a message later (e.g. if we change the prompt) without
  -- duplicating rows.
  message_id          text primary key,
  thread_id           text not null,
  -- Client this message rolls up to. Nullable because the scanner may
  -- score a message before we've decided which client it belongs to;
  -- the aggregator skips null-client rows.
  client_id           text references public.clients(id) on delete cascade,
  account_id          text,
  -- 'inbound' = from client, 'outbound' = from us. Outbound messages
  -- are scored on response quality / clarity / responsiveness instead
  -- of client sentiment, but the same 0-100 scale.
  direction           text not null check (direction in ('inbound', 'outbound')),
  from_address        text,
  subject             text,
  delivered_at        timestamptz,
  satisfaction_score  integer not null
    check (satisfaction_score between 0 and 100),
  reason              text,
  scored_at           timestamptz not null default now(),
  -- Which model produced the score. Lets us trace back if we change
  -- prompts or models later and want to retire stale scores.
  scored_by           text not null default 'claude-haiku-4-5'
);

create index if not exists email_satisfaction_scores_client_idx
  on public.email_satisfaction_scores(client_id, delivered_at desc)
  where client_id is not null;

create index if not exists email_satisfaction_scores_thread_idx
  on public.email_satisfaction_scores(thread_id, delivered_at desc);

create index if not exists email_satisfaction_scores_unscored_idx
  on public.email_satisfaction_scores(scored_at desc);

-- Progress tracking for the chunked backfill. One row per scan run;
-- the admin UI polls this to render "X of Y messages scored, ETA Z".
create table if not exists public.satisfaction_scan_runs (
  id              text primary key,
  started_by      text references public.users(id) on delete set null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  total_threads   integer not null default 0,
  processed_threads integer not null default 0,
  total_messages  integer not null default 0,
  scored_messages integer not null default 0,
  skipped_messages integer not null default 0,
  errored_messages integer not null default 0,
  -- 'running' | 'paused' | 'completed' | 'failed'
  status          text not null default 'running'
    check (status in ('running','paused','completed','failed')),
  -- Cursor lets a chunked endpoint resume mid-scan without scanning
  -- threads it already visited. Stores a thread_id + delivered_at
  -- pair encoded as JSON.
  cursor          jsonb,
  last_error      text,
  scope_from      timestamptz,
  scope_to        timestamptz
);

create index if not exists satisfaction_scan_runs_status_idx
  on public.satisfaction_scan_runs(status, started_at desc);
