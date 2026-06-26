-- Add the "contract" stage to the outbound sales pipeline.
--
-- Sits between 'showed' and 'success' (Won) — a deal whose contract is out
-- for signature. The application state machine (lib/outbound-stages.ts) gates
-- the legal transitions; here we just widen the status check constraint so the
-- column accepts the new value.
--
-- No change needed to outbound_lead_events.kind: a move into contract is
-- logged with the existing generic 'transitioned' kind.

alter table public.outbound_leads
  drop constraint if exists outbound_leads_status_check;

alter table public.outbound_leads
  add constraint outbound_leads_status_check
  check (status in (
    'warm_lead', 'booked', 'showed',
    'no_show', 'contract', 'success', 'lost'
  ));
