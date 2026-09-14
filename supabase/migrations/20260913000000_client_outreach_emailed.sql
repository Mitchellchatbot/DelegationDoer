-- Manual "personal email sent" check-off for the client outreach board
-- (the 2-week cadence section on /client-teams).
--
-- The board's status is derived from the LATER of this manual stamp and the
-- auto-synced last_outbound_email_at_external (real, non-automated outbound).
-- A client is "done for the cycle" while that effective date is within 14 days;
-- past 14 days it flips back to overdue on its own — so the cycle resets 14
-- days from the client's last (auto or manual) personal email.
alter table public.clients
  add column if not exists outreach_emailed_at timestamptz;
