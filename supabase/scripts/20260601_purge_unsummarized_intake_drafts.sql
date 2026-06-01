-- One-time cleanup for the noise that landed in routing-review BEFORE the
-- email-intake filter/classifier hardening (commit on branch
-- fix/email-intake-railway-scheduler).
--
-- Every one of these rows shares the same signature: the classifier could
-- not read the email, so it fell back to the placeholder body
-- "Couldn't auto-summarize this one — open the thread for the full email."
-- That string is the precise, safe marker — it only ever appears on the
-- classifier error-fallback path, never on a genuinely-summarized task.
--
-- This is data cleanup, NOT a schema migration — run it manually once
-- against your Supabase project (SQL editor or psql). It is intentionally
-- conservative: it SOFT-rejects (status='rejected'), preserving the row +
-- routing_decisions audit trail, exactly like the "Deny" button does.
--
-- Run it inside a transaction so you can inspect the counts and ROLLBACK
-- if anything looks off before COMMIT.

begin;

-- 1) PREVIEW — how many draft tasks match the error-fallback signature.
select count(*) as pending_noise_drafts
from public.tasks
where is_draft = true
  and tags @> array['email-intake']
  and description ilike '%Couldn''t auto-summarize%';

-- 2) PREVIEW — how many "Needs routing" fallback rows match (task_id IS NULL).
select count(*) as needs_routing_noise
from public.routing_decisions
where task_id is null
  and needs_review = true
  and classifier_output->>'description' ilike '%Couldn''t auto-summarize%';

-- 3) Soft-reject the noise draft tasks (mirrors rejectDraftTask()).
update public.tasks
set is_draft = false,
    status = 'rejected'
where is_draft = true
  and tags @> array['email-intake']
  and description ilike '%Couldn''t auto-summarize%';

-- 4) Clear the needs-review flag on the matching task_id IS NULL fallback
--    decisions so they drop out of the "Needs routing" tab. The audit row
--    stays for the record.
update public.routing_decisions
set needs_review = false
where task_id is null
  and needs_review = true
  and classifier_output->>'description' ilike '%Couldn''t auto-summarize%';

-- Inspect the two preview counts above, then:
--   COMMIT;    -- to apply
-- or
--   ROLLBACK;  -- to back out
commit;
