-- Round out the profile with contact + bio fields people actually
-- need to look up day-to-day. `email` stays as the auth identity
-- (work email used to sign in); the new columns add:
--   - personal_email: for after-hours reach-out
--   - phone: optional, formatted however the user types it
--   - job_title: their actual role on the team ("Lead designer")
--                vs. the system role (worker/dept_head/leader)
--   - location: city / timezone hint
--   - bio: short freeform "about me" string
--   - pronouns: optional
--
-- Visibility (enforced in the API, not the schema): public fields
-- are job_title + location + bio + pronouns. Personal email + phone
-- are only ever returned to the user themselves and to leaders.

alter table public.users
  add column if not exists personal_email text,
  add column if not exists phone         text,
  add column if not exists job_title     text,
  add column if not exists location      text,
  add column if not exists bio           text,
  add column if not exists pronouns      text;
