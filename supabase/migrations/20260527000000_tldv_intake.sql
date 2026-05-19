-- tl;dv auto-intake. The webhook route receives TranscriptReady events,
-- runs each meeting through the meeting classifier → routing-rules →
-- assignee-hint → ranker → AI fallback pipeline, and fans out one task
-- per action item. This table tracks which meetings we've already
-- processed (so a retried webhook is idempotent) plus an audit trail of
-- the action items extracted.

create table if not exists tldv_intake_log (
  meeting_id text primary key,        -- tl;dv meetingId
  webhook_id text,                    -- webhook payload id (for tracing retries)
  task_ids text[] not null default '{}',  -- every task we spawned for this meeting
  routed_summary jsonb,               -- [{taskId, routedVia, routedToUserId}] for audit
  raw_payload jsonb,                  -- snapshot of the webhook body, for replay
  processed_at timestamptz not null default now()
);

create index if not exists tldv_intake_log_processed_idx on tldv_intake_log(processed_at desc);
