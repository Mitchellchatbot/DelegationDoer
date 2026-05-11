-- Optional birthday on each user.
--
-- Stored as a DATE (yyyy-mm-dd) so we have the year too — useful if we
-- ever want age-based affordances — but birthday-matching is
-- year-agnostic: queries compare month/day, ignoring year.

alter table users
  add column if not exists birthday date;
