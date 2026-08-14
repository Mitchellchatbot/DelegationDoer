-- One-time repair for EOD rows that were stamped with the UTC calendar
-- date instead of the workspace (America/New_York) one, BEFORE the day
-- boundary moved to midnight ET.
--
-- Background. Every EOD writer used to derive its date from
-- new Date().toISOString().slice(0, 10) — the UTC date. 00:00 UTC is
-- 8pm EDT / 7pm EST, so anything filed between ~8pm ET and midnight ET
-- was written against TOMORROW's note_date. The next morning the app
-- (also on UTC) loaded that same row: `submitted_at` was already set,
-- so the worker was locked out of filing that day, and autosave
-- overwrote the previous evening's answers field by field. No
-- duplicate-key error ever fired, because `id` and the
-- (user_id, note_date) key moved together.
--
-- The code fix (eodToday() in src/lib/shift.ts) stops NEW rows landing
-- wrong. It does not move the ones already written. Until they move,
-- every worker who filed the evening before the deploy hits the
-- collision exactly one more time.
--
-- This is data cleanup, NOT a schema migration — run it manually once
-- against your Supabase project (SQL editor or psql), AFTER the code is
-- deployed. Run it inside the transaction below, read the previews, and
-- ROLLBACK if anything looks off before you COMMIT.
--
-- What counts as mis-dated, precisely:
--     note_date = (created_at at time zone 'UTC')::date
--       -- the row was auto-dated, not deliberately back-dated by a
--       -- client that passed an explicit older `date`
--   and note_date <> (created_at at time zone 'America/New_York')::date
--       -- and the two calendars actually disagree for that instant
--
-- SCOPE. Section 2 only repairs rows dated today-or-later on the ET
-- calendar. Those are the ones still ahead of the clock, so they hold
-- nothing but that evening's work and cannot have been merged into yet
-- — they are also the only ones that would still collide. Older
-- mis-dated rows are left alone on purpose: each is internally
-- consistent (its id matches its note_date, its reactions still point
-- at it) and merely files one day forward in /eod history. Several have
-- already been overwritten by the next morning's autosave, so shifting
-- them back would relabel the WRONG day's text. See section 4 before
-- deciding to go further.

begin;

-- ---------------------------------------------------------------------
-- 1) PREVIEW — the full historical extent of the problem, all four
--    tables. Nothing is modified by this section.
-- ---------------------------------------------------------------------

select 'eod_notes' as tbl, count(*) as misdated_rows
from public.eod_notes
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date
union all
select 'eod_client_work', count(*)
from public.eod_client_work
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date
union all
select 'eod_client_updates', count(*)
from public.eod_client_updates
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date
union all
select 'eod_client_checkins', count(*)
from public.eod_client_checkins
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date;

-- ---------------------------------------------------------------------
-- 2) REPAIR the still-colliding rows: note_date >= today (ET).
-- ---------------------------------------------------------------------

-- 2a) eod_notes. The id encodes the date (`eod_<userId>_<date>`), so it
--     has to be rewritten in lockstep — and update_reactions.target_id /
--     update_replies.target_id reference that id as free text with no
--     FK, so they must move in the same transaction or the reactions
--     silently detach from the row they were left on.
--
--     Rows whose corrected date would collide with an existing row for
--     the same user (someone who filed at 6pm AND again at 9pm) are
--     excluded — merging two bodies of text is a content decision, not
--     a SQL shift. Section 3 lists them for manual review.
create temporary table eod_notes_repair on commit drop as
select
  n.id                                                      as old_id,
  n.user_id,
  n.note_date                                               as old_date,
  (n.created_at at time zone 'America/New_York')::date       as new_date,
  'eod_' || n.user_id || '_' ||
    to_char((n.created_at at time zone 'America/New_York')::date, 'YYYY-MM-DD')
                                                            as new_id
from public.eod_notes n
where n.note_date = (n.created_at at time zone 'UTC')::date
  and n.note_date <> (n.created_at at time zone 'America/New_York')::date
  and n.note_date >= (now() at time zone 'America/New_York')::date
  and not exists (
    select 1 from public.eod_notes c
    where c.user_id = n.user_id
      and c.note_date = (n.created_at at time zone 'America/New_York')::date
  );

select count(*) as eod_notes_to_repair from eod_notes_repair;

update public.update_reactions r
set target_id = p.new_id
from eod_notes_repair p
where r.target_type = 'eod' and r.target_id = p.old_id;

update public.update_replies r
set target_id = p.new_id
from eod_notes_repair p
where r.target_type = 'eod' and r.target_id = p.old_id;

update public.eod_notes n
set id = p.new_id,
    note_date = p.new_date
from eod_notes_repair p
where n.id = p.old_id;

-- 2b) The client-scoped tables. Their ids are random (`ecw_...` etc.),
--     nothing references them by a date-derived key, and none of them
--     carries a (user_id, note_date) unique constraint — so these are
--     plain column updates with no collision risk.
update public.eod_client_work
set note_date = (created_at at time zone 'America/New_York')::date
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date
  and note_date >= (now() at time zone 'America/New_York')::date;

update public.eod_client_updates
set note_date = (created_at at time zone 'America/New_York')::date
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date
  and note_date >= (now() at time zone 'America/New_York')::date;

update public.eod_client_checkins
set note_date = (created_at at time zone 'America/New_York')::date
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date
  and note_date >= (now() at time zone 'America/New_York')::date;

-- ---------------------------------------------------------------------
-- 3) REVIEW — mis-dated eod_notes in scope that were SKIPPED because the
--    corrected date is already taken. Expect this to be empty or tiny.
--    Resolve by hand: usually the two rows want concatenating, and the
--    later `submitted_at` / `reviewed_at` is the one to keep.
-- ---------------------------------------------------------------------

select
  n.id,
  n.user_id,
  n.note_date                                          as filed_as,
  (n.created_at at time zone 'America/New_York')::date  as should_be,
  n.created_at,
  n.submitted_at
from public.eod_notes n
where n.note_date = (n.created_at at time zone 'UTC')::date
  and n.note_date <> (n.created_at at time zone 'America/New_York')::date
  and n.note_date >= (now() at time zone 'America/New_York')::date
  and exists (
    select 1 from public.eod_notes c
    where c.user_id = n.user_id
      and c.note_date = (n.created_at at time zone 'America/New_York')::date
  )
order by n.note_date desc, n.user_id;

-- ---------------------------------------------------------------------
-- 4) REVIEW — historical rows deliberately left alone, split by whether
--    they are still safe to move.
--
--    `clean`   — created and last touched on the same ET day, so the
--                content still belongs to that evening. Shifting these
--                back would be correct if you want full history repaired.
--    `merged`  — updated on a LATER ET day than they were created: the
--                next morning's autosave has already written into them.
--                Their text is now the newer day's. Do NOT shift these;
--                the older evening's answers are already gone.
--
--    If you decide to repair the `clean` set too, reuse section 2a with
--    the `note_date >= today` predicate dropped and an added
--    `and (updated_at at time zone 'America/New_York')::date
--         = (created_at at time zone 'America/New_York')::date`.
-- ---------------------------------------------------------------------

select
  case
    when (updated_at at time zone 'America/New_York')::date
       = (created_at at time zone 'America/New_York')::date
    then 'clean' else 'merged'
  end as disposition,
  count(*) as rows
from public.eod_notes
where note_date = (created_at at time zone 'UTC')::date
  and note_date <> (created_at at time zone 'America/New_York')::date
  and note_date < (now() at time zone 'America/New_York')::date
group by 1;

-- Inspect the output above, then:
--   COMMIT;    -- to keep the section-2 repair
--   ROLLBACK;  -- to discard it
rollback;
