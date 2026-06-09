-- Client-by-client EOD work log — the new shape of the end-of-day form
-- for the SEO + Website teams. Each row is "what {user} worked on for
-- {client} on {date}", captured as the worker goes client-by-client in
-- the typeform (pick a client, say what you worked on + results, repeat).
--
-- This is the SOURCE the client-update emails are drafted from (replacing
-- the task-based source): the composer pulls a client's entries over a
-- window, groups them by the contributor's department (SEO vs Website),
-- and the AI writes one client email per department from worked_on +
-- results. reported_to_client_at is stamped when an email that included
-- the entry actually sends, so the same work never gets reported twice.
--
-- Distinct from eod_client_updates / eod_client_checkins (both Slack-post
-- touch logs): this one is purpose-built as the email source and carries
-- the structured worked_on + results fields the drafter needs.

create table if not exists public.eod_client_work (
  id           text primary key,
  user_id      text not null references public.users(id) on delete cascade,
  -- Calendar date the work is filed against (worker's local TZ), same
  -- convention as eod_notes / eod_client_updates.
  note_date    date not null,
  -- FK to clients; nullable so an entry survives a client deletion. We
  -- keep client_name as a copy and the email source matches on it (the
  -- legacy linkage used everywhere on the client page).
  client_id    text references public.clients(id) on delete set null,
  client_name  text not null,
  worked_on    text not null,
  results      text,
  -- Stamped when an email that included this entry sends, so the
  -- composer never re-surfaces already-reported work. Mirrors
  -- tasks.reported_to_client_at.
  reported_to_client_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The email source query: a client's entries in a date window.
create index if not exists eod_client_work_client_date_idx
  on public.eod_client_work (client_name, note_date desc);
-- The form resume / history query: a worker's entries for a date.
create index if not exists eod_client_work_user_date_idx
  on public.eod_client_work (user_id, note_date desc);

-- Many-to-many link of which EOD work entries each email draft was built
-- from. Mirrors email_draft_tasks. Populated on draft create; on send the
-- approve route stamps eod_client_work.reported_to_client_at via these
-- links (see markTasksReportedFromDraft, which also walks this table).
create table if not exists public.email_draft_eod_work (
  draft_id    text not null references public.email_drafts(id) on delete cascade,
  eod_work_id text not null references public.eod_client_work(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (draft_id, eod_work_id)
);

create index if not exists email_draft_eod_work_work_idx
  on public.email_draft_eod_work (eod_work_id);
