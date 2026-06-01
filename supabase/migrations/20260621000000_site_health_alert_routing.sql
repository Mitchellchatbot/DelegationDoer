-- Auto-create Website-Team tasks from low site-health alerts.
--
-- The existing n8n website-monitoring workflow posts alerts into the
-- Scaled Team Slack channel, e.g.:
--   "Alert: https://floridasoberlivinghomes.com/ is slow! Score: 65"
-- When the reported score falls below a configurable threshold we open a
-- task for the Website team (assigned to Elaine, with Leizel notified).
--
-- This migration adds:
--   1. A configurable threshold on the workspace_settings singleton, so
--      the cut-off is editable from the admin/settings panel instead of
--      living in code.
--   2. A site_health_alerts audit/idempotency table — one row per Slack
--      alert message — that both records the routing (website / score /
--      Slack message id / task id / timestamp) AND prevents duplicate
--      tasks for the same alert (the Slack channel+ts is unique).

-- 1) Configurable threshold. Default 70 matches the spec's example.
alter table public.workspace_settings
  add column if not exists low_site_score_threshold integer not null default 70;

-- 2) Audit + idempotency for site-health alerts.
--    The (slack_channel_id, slack_message_ts) pair is Slack's natural
--    message identity, so the unique constraint is what stops the same
--    alert (including Slack's at-least-once event redelivery and n8n's
--    "edited" re-posts) from spawning duplicate tasks.
create table if not exists public.site_health_alerts (
  id text primary key,
  slack_channel_id text not null,
  slack_message_ts text not null,        -- Slack message id (idempotency key)
  slack_permalink text,                  -- deep-link back to the alert message
  website text not null,                 -- full URL as posted
  domain text,                           -- normalized host (www-stripped)
  site_score integer not null,
  threshold integer not null,            -- threshold in force when detected
  priority text,                         -- 'high' | 'medium' | null (no task)
  -- The task we opened. ON DELETE SET NULL keeps the audit row (and its
  -- score/website snapshot) intact if the task is later hard-purged,
  -- mirroring task_deletions / email_intake_log.
  task_id text references public.tasks(id) on delete set null,
  -- Why no task was created, when applicable (e.g. 'above-threshold',
  -- 'no-assignee'). Null when a task was opened.
  skipped_reason text,
  detected_at timestamptz not null default now(),  -- alert timestamp
  created_at timestamptz not null default now(),
  unique (slack_channel_id, slack_message_ts)
);

create index if not exists site_health_alerts_created_at_idx
  on public.site_health_alerts (created_at desc);

alter table public.site_health_alerts enable row level security;
