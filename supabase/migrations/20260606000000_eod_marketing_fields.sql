-- Two optional fields used by the Marketing-style EOD flow (Talha Ali
-- currently). Plain text (not numeric) so workers can answer "12" or
-- "around 15, a few got disqualified" without coercion. Untouched for
-- non-Marketing flows — columns stay null and are simply skipped by the
-- renderer + Slack formatter.

alter table eod_notes
  add column if not exists leads_messaged    text,
  add column if not exists linkedin_comments text;
