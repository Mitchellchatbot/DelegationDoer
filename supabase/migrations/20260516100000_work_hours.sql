-- Per-user work hours. Stored as the times in the user's *own*
-- timezone — display logic converts to the viewer's local time
-- so a 7–2 Karachi schedule shows up as 10pm–5am to an EST viewer.
-- IANA timezone names so DST + offset shifts handle themselves.

alter table public.users
  add column if not exists work_hours_start text, -- "HH:MM" 24h
  add column if not exists work_hours_end   text, -- "HH:MM" 24h
  add column if not exists work_timezone    text; -- IANA, e.g. "Asia/Karachi"
