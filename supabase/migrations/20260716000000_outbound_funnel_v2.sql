-- Outbound funnel v2 — editable SMS templates + dynamic Typeform variables.
--
-- 1. outbound_message_templates: replaces the hardcoded constants in
--    lib/outbound-sms-templates.ts. The operator edits copy through the
--    /outbound-dashboard/templates page; the runner renders bodies from
--    this table at schedule time. Hardcoded defaults stay in code as a
--    fallback so an unseeded table doesn't break the flow.
--
-- 2. outbound_leads.typeform_answers: normalized map of every Typeform
--    answer keyed by the question's ref. Lets template authors splice
--    arbitrary form responses into SMS copy via {ref} placeholders
--    (e.g. a Typeform question with ref="city" can be referenced as
--    {city} in any template). Raw payload still lives in typeform_payload
--    for audits.

-- ============================================================================
-- outbound_message_templates
-- ============================================================================
create table if not exists public.outbound_message_templates (
  kind            text not null check (kind in (
                    'confirmation', 'reminder_24h', 'reminder_1h',
                    'recovery_drip', 'engagement_drip'
                  )),
  sequence_index  int not null default 1,
  body            text not null,
  updated_at      timestamptz not null default now(),
  -- Last operator to save this template. NULL = seed/default value.
  updated_by      text references public.users(id) on delete set null,
  primary key (kind, sequence_index)
);

alter table public.outbound_message_templates enable row level security;

-- Touch updated_at on every UPDATE so the editor UI can show "edited
-- 2 hours ago" without callers having to remember.
create or replace function public.outbound_templates_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists outbound_templates_touch on public.outbound_message_templates;
create trigger outbound_templates_touch
  before update on public.outbound_message_templates
  for each row execute function public.outbound_templates_touch_updated_at();

-- Seed defaults. Em-dashes scrubbed in favor of commas/periods so the
-- copy reads naturally in iMessage (no smart-quote rendering surprises).
-- `on conflict do nothing` makes this safe to re-run.
insert into public.outbound_message_templates (kind, sequence_index, body) values
  ('confirmation', 1,
    'Hi this is {sender_name} from Scaled AI, looking forward to our meeting on {meeting_starts_at_friendly}.'),
  ('reminder_24h', 1,
    'Reminder: our call is tomorrow at {meeting_starts_at_friendly}. Talk soon, {sender_name} at Scaled AI.'),
  ('reminder_1h', 1,
    'Heads up, we''re meeting in an hour at {meeting_starts_at_friendly}. {meeting_link}'),
  ('recovery_drip', 1,
    'Hey {name}, {sender_name} here from Scaled AI. Saw your form come in but didn''t see a meeting booked yet. Want to grab a quick 15? {meeting_link}'),
  ('recovery_drip', 2,
    'Hi {name}, didn''t catch you earlier. Here are a couple of case studies you might find useful: {case_studies_url}'),
  ('recovery_drip', 3,
    'Hey {name}, it''s been a week. If now isn''t the right time I totally get it. If it is, here''s a quick way to grab time: {meeting_link}'),
  ('recovery_drip', 4,
    'Just wanted to share something we wrote that''s been helpful for folks in your position: {case_studies_url}'),
  ('recovery_drip', 5,
    'Final note from me, {name}. If it ever does become the right time we''re here. {meeting_link}'),
  ('engagement_drip', 1,
    'Hey {name}, sorry we missed each other. Want me to send a few times that work for next week? {meeting_link}'),
  ('engagement_drip', 2,
    'Heads up, these case studies came up in a similar convo today: {case_studies_url}'),
  ('engagement_drip', 3,
    '{name}, no pressure but happy to hop on a quick call if useful. {meeting_link}'),
  ('engagement_drip', 4,
    'Sharing something I think you''d appreciate: {case_studies_url}'),
  ('engagement_drip', 5,
    'Last note. If there''s a better time to reconnect, just reply with a date. Otherwise wishing you the best.')
on conflict (kind, sequence_index) do nothing;

-- ============================================================================
-- outbound_leads.typeform_answers
-- ============================================================================
-- Map of { typeform_ref → string answer } extracted from the form
-- response at webhook time. Templates can reference any ref as {ref}.
-- Defaults to '{}' so existing rows don't have to be backfilled.
alter table public.outbound_leads
  add column if not exists typeform_answers jsonb not null default '{}'::jsonb;
