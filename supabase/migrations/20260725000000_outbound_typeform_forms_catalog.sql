-- Backfill: outbound_typeform_forms catalog + outbound_leads.typeform_form_id.
--
-- The multi-Typeform leads feature (PR #169) shipped code that reads the
-- public.outbound_typeform_forms catalog and the outbound_leads
-- .typeform_form_id column, but the DDL creating them never landed in a
-- migration (it was applied straight on the live DB). This migration makes a
-- fresh `supabase db push` / clean checkout reproduce the live schema.
-- Everything is IF NOT EXISTS / idempotent so it's a no-op where the objects
-- already exist.

-- ============================================================================
-- outbound_typeform_forms — maps a Typeform form_id to a human label.
-- Rendered as the per-form blocks + source filter on /outbound-dashboard/leads
-- and edited through the "Manage forms" drawer. See lib/outbound-typeform-forms.ts.
-- ============================================================================
create table if not exists public.outbound_typeform_forms (
  -- Typeform form_id (from form_response.form_id). Natural primary key.
  id           text primary key,
  label        text not null,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.outbound_typeform_forms enable row level security;

-- Touch updated_at on every UPDATE (matches the outbound_leads /
-- outbound_message_templates pattern).
create or replace function public.outbound_typeform_forms_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists outbound_typeform_forms_touch on public.outbound_typeform_forms;
create trigger outbound_typeform_forms_touch
  before update on public.outbound_typeform_forms
  for each row execute function public.outbound_typeform_forms_touch_updated_at();

-- ============================================================================
-- outbound_leads.typeform_form_id — which form sent this lead. Stamped from
-- form_response.form_id on the webhook; joined to the catalog above. NULL for
-- legacy leads created before per-form tracking.
-- ============================================================================
alter table public.outbound_leads
  add column if not exists typeform_form_id text;

create index if not exists outbound_leads_typeform_form_id_idx
  on public.outbound_leads (typeform_form_id);
