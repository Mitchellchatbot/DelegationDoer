-- Facebook EOD flow extras: "Any ideas?" and "Did you comment where you left
-- off + submit?" Plain text, nullable — ignored by the other EOD flows.
alter table eod_notes
  add column if not exists ideas text,
  add column if not exists left_where_off text;
