-- Dazos daily VOB reports → the AWFMP dashboard's ingest endpoint.
--
-- Dazos mails two CSVs a day (Q2R / QBH META VOBS LIFETIME). The webhook
-- pushes each attachment on arrival; this table is the log of what was sent,
-- what came back, and what still needs retrying.
--
-- It is observability, not correctness: the ingest endpoint upserts, so a
-- double-push rewrites the same rows. One row per attachment, so a repeated
-- webhook for the same message is a no-op rather than a second POST.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

create table if not exists public.dazos_report_pushes (
  -- The clone's attachment id. Primary key = the dedupe.
  attachment_id text primary key,
  message_id    text not null,
  thread_id     text,
  subject       text not null,
  -- q2r | qbh, read off the subject. The endpoint routes on `report` anyway.
  campaign      text not null,
  filename      text,
  size_bytes    integer,
  -- pending  — seen, not yet pushed (sweep will pick it up)
  -- pushed   — endpoint returned 200
  -- failed   — retryable failure (5xx / network); the sweep retries it
  -- rejected — permanent (400/401/404); needs a human, never retried
  status        text not null default 'pending'
                check (status in ('pending', 'pushed', 'failed', 'rejected')),
  http_status   integer,
  response      text,
  error         text,
  attempts      integer not null default 0,
  first_seen_at timestamptz not null default now(),
  pushed_at     timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists dazos_report_pushes_status_idx
  on public.dazos_report_pushes (status, first_seen_at desc);

alter table public.dazos_report_pushes enable row level security;

-- attempts += 1 for one attachment. A plain supabase-js update can't express
-- a self-referencing increment, and two retries racing would otherwise write
-- the same number twice.
create or replace function public.dazos_push_attempt(p_attachment_id text)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.dazos_report_pushes
     set attempts = attempts + 1,
         updated_at = now()
   where attachment_id = p_attachment_id
  returning attempts;
$$;
