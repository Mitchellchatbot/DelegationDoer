-- Whole-client removal from the outreach board only (the × next to the client
-- name on the "Personal email cadence" section). The client stays a normal
-- client everywhere else; this just drops them from that board. Reversible via
-- the board's "show removed" restore.
alter table public.clients
  add column if not exists outreach_hidden boolean not null default false;
