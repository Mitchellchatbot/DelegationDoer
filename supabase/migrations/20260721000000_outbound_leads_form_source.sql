-- Typeform attribution for manually-entered outbound leads.
--
-- Operators can add leads by hand via the dashboard "Add a lead" modal. Until
-- now a manual lead carried no record of which typeform/campaign it came from.
-- This column stores the operator's chosen source (one of the hardcoded
-- FORM_SOURCES in src/lib/outbound-form-sources.ts).
--
-- Nullable with no default: the Typeform webhook does not set it, so
-- webhook-ingested leads and all existing rows keep form_source = null.
alter table public.outbound_leads add column if not exists form_source text;
