-- Touchpoint dashboard was reading only from email_drafts (status='sent'),
-- which captures emails composed inside DelegationDoer. Anything sent
-- straight from Missive (the old workflow) never lit up the dashboard,
-- so 43 of ~44 clients showed up as "Never emailed via DelegationDoer"
-- even though the team had been emailing them for months.
--
-- Fix: a periodic sync walks missiveclone's SENT folder, matches each
-- thread to a client via the existing client-thread-match signals, and
-- stores the latest send date / subject denormalized on `clients` so
-- the touchpoint helper can read it in one round-trip.
--
-- The touchpoint helper then resolves the effective last-outbound time
-- as MAX(email_drafts.sent_at, clients.last_outbound_email_at_external).

alter table public.clients
  add column if not exists last_outbound_email_at_external  timestamptz,
  add column if not exists last_outbound_subject_external   text,
  add column if not exists touchpoint_synced_at             timestamptz;

create index if not exists clients_last_outbound_external_idx
  on public.clients(last_outbound_email_at_external desc nulls last);
