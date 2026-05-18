-- The status_emoji column was capped at 8 chars to fit unicode emoji
-- (typically 1-4 codepoints). We now allow Slack custom emoji
-- shortcodes like ":spiderman:" to be stored there too, so the cap
-- needs to fit a Slack name (max 32 chars per Slack) plus the two
-- delimiting colons + headroom. Bump to 64.
--
-- Drop + re-add — Postgres doesn't have ALTER CONSTRAINT for CHECKs.

alter table public.users
  drop constraint if exists users_status_emoji_check;

alter table public.users
  add constraint users_status_emoji_check
  check (status_emoji is null or length(status_emoji) <= 64);
