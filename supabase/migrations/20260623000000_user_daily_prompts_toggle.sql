-- Per-user opt-out for SOD/EOD daily prompts.
--
-- Default true matches existing behavior. Flipped to false for users
-- who don't fit the daily-ritual flow (e.g. CEO who's already on top
-- of client work and doesn't need the widget nagging at 5pm).
-- Mirrors the per-user clock_enabled pattern from 20260515.
alter table public.users
  add column if not exists daily_prompts_enabled boolean not null default true;

-- Mitchell explicitly opted out — the EOD client-checkin nudge in the
-- widget was firing for him every day because the route enables for
-- leaders alongside the Website team. He doesn't file those check-ins.
update public.users
  set daily_prompts_enabled = false
  where lower(coalesce(name, '')) like 'mitchell%';
