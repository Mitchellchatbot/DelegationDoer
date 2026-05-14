-- Comments in activity_logs can now carry @-mentioned user ids
-- alongside the prose so the renderer can highlight mention chips
-- without re-parsing the text on every render.
alter table activity_logs
  add column if not exists mentioned_user_ids text[] not null default '{}';
