-- Per-day work schedule. Some teammates run short days on Wed/Fri,
-- some skip weekends, some flip Sat into a workday — a single
-- start/end can't express that. Stored as a small JSONB blob:
--
--   {
--     "mon": { "start": "09:00", "end": "17:00" },
--     "tue": { "start": "09:00", "end": "17:00" },
--     "wed": { "start": "09:00", "end": "13:00" },   // short day
--     "thu": { "start": "09:00", "end": "17:00" },
--     "fri": { "start": "10:00", "end": "15:00" },
--     "sat": null,                                    // day off
--     "sun": null
--   }
--
-- `null` for a day = day off. Missing key = day off (treated the same).
-- Empty object {} = falls back to flat work_hours_start/end so older
-- profiles keep their behavior until they explicitly opt in.
alter table public.users
  add column if not exists weekly_schedule jsonb not null default '{}'::jsonb;
