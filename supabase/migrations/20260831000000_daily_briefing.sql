-- Daily 9 AM founder briefing.
--
-- One row per calendar day (America/New_York). The daily-briefing cron
-- (src/lib/daily-briefing-runner.ts) writes the row, DMs Mitchell the
-- briefing on Slack with a "Send" button per drafted team message, and the
-- Slack interactions endpoint (src/app/api/slack/interactions/route.ts)
-- flips each message to "sent" as Mitchell approves it.
--
-- Presence of a row with delivered_at set is the same-day dedupe (mirrors
-- the last_*_at stamp pattern used by eod-recap / clients-emailed-push),
-- so no workspace_settings column is needed.

create table if not exists daily_briefings (
  -- Deterministic id "brief_<ET-YYYY-MM-DD>" so the day's run is idempotent
  -- (re-run before delivery upserts the same row).
  id            text primary key,
  brief_date    text not null,                       -- ET calendar day, YYYY-MM-DD
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,                         -- set once the Slack DM posts
  slack_channel text,                                -- Mitchell's DM channel id
  slack_ts      text,                                -- posted message ts (for reference)
  update_text   text not null default '',            -- the daily-update prose for Mitchell
  needle_mover  text,                                -- the one "move the needle" action
  -- Array of drafted team-engagement messages. Each element:
  --   { id, userId, name, slackId, text, status: 'pending'|'sent'|'failed',
  --     sentAt, error }
  -- status starts 'pending'; the Send button in Slack flips it to 'sent'.
  messages      jsonb not null default '[]'::jsonb,
  -- Small counts snapshot for the header/context line, so the block builder
  -- doesn't have to re-query.
  meta          jsonb not null default '{}'::jsonb
);

create index if not exists daily_briefings_brief_date_idx
  on daily_briefings (brief_date desc);
