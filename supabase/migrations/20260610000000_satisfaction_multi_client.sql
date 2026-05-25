-- Email-satisfaction PK was (message_id) — meant a single message
-- could only be attributed to one client. In practice the team runs
-- multiple Villa-* accounts that share a CSM contact email, so the
-- same email gets routed to four clients; the single-PK silently
-- dropped three of them at insert time, leaving their medians empty.
--
-- Fix: composite PK (message_id, client_id). One row per (msg, client)
-- so every Villa-* account picks up the same Colin-Mackey thread.
--
-- Migration plan:
--   1. Drop any stale rows where client_id is null (none in practice,
--      but the PK requires not-null).
--   2. Make client_id NOT NULL.
--   3. Replace the PK.
--
-- Idempotent: the new PK constraint uses a fixed name we can DROP/ADD
-- repeatedly.

delete from public.email_satisfaction_scores where client_id is null;

alter table public.email_satisfaction_scores
  alter column client_id set not null;

alter table public.email_satisfaction_scores
  drop constraint if exists email_satisfaction_scores_pkey;

alter table public.email_satisfaction_scores
  add constraint email_satisfaction_scores_pkey
  primary key (message_id, client_id);
