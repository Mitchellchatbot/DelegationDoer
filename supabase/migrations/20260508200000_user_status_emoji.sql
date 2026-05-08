-- Per-user status emoji. Surfaces in the team-presence row at the top of
-- /team alongside the avatar + presence dot. Capped at 8 chars so even
-- a multi-codepoint flag/skin-tone emoji fits but no one stuffs a tweet
-- in here.
alter table users
  add column if not exists status_emoji text check (
    status_emoji is null or length(status_emoji) <= 8
  );
