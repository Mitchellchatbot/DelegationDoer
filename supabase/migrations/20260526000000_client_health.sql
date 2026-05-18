-- Client health: a computed signal of how happy each client seems
-- based on the sentiment of their recent inbound emails, plus a
-- leader-overridable label so humans can correct the computation
-- when something off-channel changes the picture (e.g. a phone
-- call where the client vented).
--
-- Two layers:
--   * health_score / health_label — written by the daily cron from
--     gpt-4o-mini sentiment scoring across recent missive messages.
--   * health_override_* — leader-set values that win over the
--     computed ones at display time. Cleared by passing null.
--
-- UI resolves "effective" health as:
--   COALESCE(health_override_label, health_label)
-- and shows whichever exists as the badge / pill on the client.

alter table public.clients
  add column if not exists health_score        numeric,
  add column if not exists health_label        text,
  add column if not exists health_sample_size  integer,
  add column if not exists health_summary      text,
  add column if not exists health_computed_at  timestamptz,
  add column if not exists health_override_label text,
  add column if not exists health_override_note  text,
  add column if not exists health_override_by    text references public.users(id) on delete set null,
  add column if not exists health_override_at    timestamptz;

-- Label values are constrained so the UI can color-code without
-- worrying about typos. Same set for both computed + override.
alter table public.clients
  drop constraint if exists clients_health_label_check;
alter table public.clients
  add constraint clients_health_label_check
  check (health_label is null or health_label in ('thriving','steady','shaky','at_risk'));

alter table public.clients
  drop constraint if exists clients_health_override_label_check;
alter table public.clients
  add constraint clients_health_override_label_check
  check (health_override_label is null or health_override_label in ('thriving','steady','shaky','at_risk'));
