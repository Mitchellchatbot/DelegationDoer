-- Per-user toggle for the time-clock feature. Default true so the
-- existing hourly-tracked employees keep clocking in. Leader flips
-- this off for salaried / on-call roles where clocking in doesn't
-- make sense — those folks see no clock UI in the widget and don't
-- factor into "workday remaining" math.

alter table public.users
  add column if not exists clock_enabled boolean not null default true;
