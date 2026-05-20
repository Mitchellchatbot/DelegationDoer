-- Structured EOD fields per the v2 fix list (Section 2). Replaces the
-- single free-form `note` column with four prompts that match the spec:
--   - worked_on      "What did you work on today?" (required)
--   - accomplished   "What did you accomplish?"    (required)
--   - plan_tomorrow  "Plan for tomorrow"           (required)
--   - blockers       "Any questions or blockers?"  (optional)
-- Kept additively — the existing `note` column stays as a back-compat
-- catch-all (used by the AI-tools EOD summary endpoint), and any row
-- pre-dating this migration continues to load.

alter table eod_notes
  add column if not exists worked_on text,
  add column if not exists accomplished text,
  add column if not exists plan_tomorrow text,
  add column if not exists blockers text;
