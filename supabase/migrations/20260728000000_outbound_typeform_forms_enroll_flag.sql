-- Per-form flow enrollment toggle for the outbound funnel.
--
-- Previously every Typeform submission auto-enrolled the new lead into the
-- Recovery drip SMS sequence (the only flow a form submission triggers). This
-- adds a per-form switch so operators can decide which forms feed the sequence
-- and which only create leads. See lib/outbound-typeform-forms.ts and the
-- "Manage forms" drawer.
--
-- Default true preserves today's behavior — existing forms keep enrolling, and
-- unregistered forms (no catalog row) still enroll via the webhook default.

alter table public.outbound_typeform_forms
  add column if not exists enroll_in_flow boolean not null default true;
