-- Client meeting records — the structured store behind the tl;dv →
-- Client Knowledge Base → Team Brief automation.
--
-- The tl;dv intake pipeline (lib/tldv-intake.ts) already classifies a
-- transcript into a summary + action items and fans those out as draft
-- tasks. This table is where the *meeting itself* now lives, attached to
-- the matched client: the full transcript, the one-paragraph summary, the
-- generated team brief (key decisions / action items / client requests /
-- risks / next steps), the participants, the meeting date, and the source
-- recording link. The client detail page renders these as a Meetings &
-- briefs timeline, and the Ask-AI assistant reads them via the
-- list_client_meetings tool so future answers/drafts/tasks can draw on
-- what was said in the room.
--
-- Linkage to clients stays consistent with the rest of the Client Hub —
-- a real FK on client_id (cascade) since these rows are born already
-- matched to a client (unmatched meetings simply aren't stored here).
-- Tasks spawned from the meeting are tracked by task_ids[] (the same ids
-- recorded in tldv_intake_log.task_ids) so the timeline can link back to
-- the work that came out of the meeting.

create table if not exists public.client_meetings (
  id            text primary key,
  client_id     text not null references public.clients(id) on delete cascade,
  -- tl;dv meetingId (or the zap_<hash> id the Zapier passthrough path
  -- synthesizes). Unique per client so a retried webhook / manual replay
  -- upserts the same row instead of duplicating it.
  meeting_id    text not null,
  source        text not null default 'tldv',          -- tldv | zapier | manual
  source_url    text,                                   -- recording / viewer link
  title         text not null,
  meeting_date  timestamptz not null default now(),     -- when the meeting happened (webhook executedAt, else processed time)
  participants  text[] not null default '{}',           -- speaker names from the transcript
  summary       text,                                   -- one-paragraph meeting summary
  -- Structured team brief: { keyDecisions[], actionItems[], clientRequests[], risks[], nextSteps[] }.
  brief         jsonb,
  transcript    text,                                   -- full transcript text (speaker-prefixed when available)
  task_ids      text[] not null default '{}',           -- draft tasks spawned from this meeting
  created_at    timestamptz not null default now(),
  unique (client_id, meeting_id)
);

create index if not exists client_meetings_client_id_idx
  on public.client_meetings (client_id, meeting_date desc);
create index if not exists client_meetings_meeting_id_idx
  on public.client_meetings (meeting_id);

alter table public.client_meetings enable row level security;
