-- Drop the redundant outbound_leads.form_source column.
--
-- form_source (migration 20260721000000) plus a hardcoded FORM_SOURCES constant
-- were an early attempt at "which typeform a manual lead came from". The team
-- subsequently shipped the proper, dynamic system: the outbound_typeform_forms
-- catalog + outbound_leads.typeform_form_id, auto-stamped from the webhook's
-- form_response.form_id. The manual "Add lead" modal now writes typeform_form_id
-- too (validated against the catalog), so form_source is dead — nothing reads
-- or writes it. Remove it so there is a single source of truth.
alter table public.outbound_leads drop column if exists form_source;
