-- Slack ping in #email-notifs whenever a known client emails one of our
-- inboxes. Requested by Bismah: "It would be great if we can get notification
-- on our slack channel whenever any client email us so we can reply him on
-- time."
--
-- Two pieces:
--   1. Where to post  — a workspace_settings column, so the channel can be
--      re-pointed from the UI without a redeploy (same pattern as
--      scaled_team_channel_id / eod_recap_channel_id).
--   2. What we already posted — an idempotency claim table.

alter table public.workspace_settings
  add column if not exists client_email_channel_id text;

-- Seed the private #email-notifs channel created for this. Only fills a NULL
-- so re-running the migration never stomps a channel changed via the UI.
update public.workspace_settings
   set client_email_channel_id = 'C0BQ6H8U693',
       updated_at = now()
 where id = 'workspace'
   and client_email_channel_id is null;

-- Cross-process idempotency claim for the Slack post.
--
-- DD learns about a new message from THREE places (the HMAC webhook, the
-- socket.io bridge, and the safety-net poll), and prod runs more than one
-- app instance. The in-process 30s dedupe in src/lib/missive-socket.ts is
-- per-process, so it cannot stop two instances from both posting. The
-- primary key here is the real lock: every path INSERTs before calling
-- Slack, and whichever loses gets 23505 and backs off. Collisions land in
-- Postgres instead of in the channel.
--
-- message_id is missiveclone's `messages.id` (a uuid string), not the RFC
-- Message-ID header — that's what rides on the webhook/socket payload.
create table if not exists public.slack_client_email_posts (
  message_id    text primary key,
  thread_id     text not null,
  account_id    text not null,
  -- Which client we attributed the sender to. Nullable + ON DELETE SET NULL
  -- so removing a client never blocks or rewrites notification history.
  client_id     text references public.clients(id) on delete set null,
  client_name   text,
  from_email    text,
  subject       text,
  slack_channel text,
  -- Populated after chat.postMessage succeeds. A row with a null slack_ts is
  -- a claim that never made it to Slack (the poster deletes those on failure
  -- so the safety-net poll can retry, but a hard crash mid-post can leave
  -- one behind).
  slack_ts      text,
  posted_at     timestamptz not null default now()
);

-- The debug route lists "most recent posts", so index that direction.
create index if not exists slack_client_email_posts_posted_at_idx
  on public.slack_client_email_posts (posted_at desc);

-- Same posture as email_notifications: RLS on with no policy. Every reader
-- and writer goes through the service-role key on the server, and the rows
-- carry client subjects, so nothing should reach an anon/authenticated
-- client directly.
alter table public.slack_client_email_posts enable row level security;
