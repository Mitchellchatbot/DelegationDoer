-- Per-client list of sites hidden from the outreach board ONLY.
--
-- Removing a site on the "Personal email cadence" board should not delete it
-- from the client's real websites[] (which also feeds the task form, profile,
-- etc.) — it just declutters the email section. This column holds the sites to
-- omit from that board; websites[] stays intact.
alter table public.clients
  add column if not exists outreach_hidden_sites text[] not null default '{}'::text[];
