-- Add the 'sequence_changed' event kind to outbound_lead_events.
--
-- Recorded when a rep manually moves a lead from one SMS nurture sequence to
-- another (Recovery <-> Engagement, or out of Booking) via the Flow board on
-- the Flows tab. The original migration's comment anticipated this: "New kinds
-- are added as the funnel grows; the check constraint can be relaxed in a
-- later migration."

alter table public.outbound_lead_events
  drop constraint if exists outbound_lead_events_kind_check;

alter table public.outbound_lead_events
  add constraint outbound_lead_events_kind_check
  check (kind in (
    'form_submitted',
    'meeting_booked',
    'meeting_canceled',
    'first_text_sent',
    'reminder_24h_sent',
    'reminder_1h_sent',
    'drip_sent',
    'marked_no_show',
    'marked_showed',
    'marked_sold',
    'marked_lost',
    'sequence_completed',
    'transitioned',
    'sequence_changed'
  ));
