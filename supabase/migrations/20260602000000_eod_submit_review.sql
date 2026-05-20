-- Adds the "submit" + "review" lifecycle to eod_notes per the v2 fix
-- list (Section 2). Until now the four structured fields autosaved on
-- blur but there was no signal "I'm done filling this out for today" —
-- so leadership couldn't be DM'd a digest, and dept heads had nothing
-- to tick off as reviewed.
--
-- submitted_at  — set when the worker hits "Submit EOD." Triggers the
--                 Slack delivery to leaders + dept head(s).
-- reviewed_at   — set when a dept head ticks off the submission.
-- reviewed_by   — user_id of whoever ticked it off (so leadership can
--                 see *who* reviewed it, not just that it was reviewed).

alter table eod_notes
  add column if not exists submitted_at   timestamptz,
  add column if not exists reviewed_at    timestamptz,
  add column if not exists reviewed_by    text references public.users(id) on delete set null;

create index if not exists eod_notes_submitted_at_idx
  on eod_notes(submitted_at desc)
  where submitted_at is not null;
