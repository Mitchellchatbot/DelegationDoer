-- Touchpoint health — a second, simpler health surface beside the
-- sentiment-based one. Where `health_label` (thriving/steady/shaky/at_risk)
-- captures *how the client feels*, touchpoint health captures *how recently
-- we've talked to them*: a traffic light driven by the last outbound email.
--
-- Auto bands (computed at read time from email_drafts.sent_at):
--   green  -> sent within last 3 days
--   yellow -> 3 < days <= 10
--   red    -> >10 days, or never emailed
--
-- Leaders can override with the four columns added below — same
-- COALESCE(override, auto) pattern the existing health system uses.
--
-- `touchpoint_summary` is a manual one-line description of the latest
-- touchpoint that someone (a leader or the account owner) can fill in
-- to give the dashboard a human-readable headline like "Reviewed Aug
-- analytics; agreed to add 4 blog posts in Sept."

alter table public.clients
  add column if not exists touchpoint_override_label text,
  add column if not exists touchpoint_override_note  text,
  add column if not exists touchpoint_override_by    text references public.users(id) on delete set null,
  add column if not exists touchpoint_override_at    timestamptz,
  add column if not exists touchpoint_summary        text,
  add column if not exists touchpoint_summary_at     timestamptz,
  add column if not exists touchpoint_summary_by     text references public.users(id) on delete set null;

alter table public.clients
  drop constraint if exists clients_touchpoint_override_label_check;
alter table public.clients
  add constraint clients_touchpoint_override_label_check
  check (touchpoint_override_label is null
         or touchpoint_override_label in ('green','yellow','red'));
