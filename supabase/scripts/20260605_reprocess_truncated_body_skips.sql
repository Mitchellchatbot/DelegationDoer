-- Re-queue inbound threads that auto-intake skipped as "not actionable"
-- (routed_via='classifier-skipped') because the classifier only saw a
-- truncated 255-char body.
--
-- ROOT CAUSE: Microsoft Graph (M365 inboxes) stored only its ~255-char
-- `bodyPreview` in messages.body_text for HTML mail; the full content lived in
-- body_html. The intake classifier read body_text, so real client emails were
-- judged isActionable=false and dropped silently (task_id=null,
-- needs_review=false → invisible in routing-review AND needs-routing).
--
-- FIX (must be deployed BEFORE running this): threadBodyFromMessages now reads
-- the fuller of body_text / stripped body_html (src/lib/email-intake-utils.ts),
-- so re-reading these threads classifies on the full email. graph.js also now
-- stores full plaintext for new Graph mail.
--
-- !!! RUN ONLY AFTER the DelegationDoer app is redeployed with the
-- !!! email-intake-utils fix. Confirm a NEW inbound HTML email from an M365
-- !!! inbox now produces a properly summarized task. Otherwise the next poll
-- !!! just re-skips these on the truncated body again.
--
-- How it works: each skipped thread has (a) a routing_decisions audit row with
-- task_id=null, routed_via='unrouted', review_reason IS NULL, and (b) an
-- email_intake_log dedupe row with routed_via='classifier-skipped'. Delete BOTH
-- and the next ~5-min poll re-reads each thread through the now-fixed full-body
-- classifier: genuine noise (receipts/marketing/test mail) re-skips silently,
-- real client mail becomes a routed draft task.
--
-- Scoped to the last 14 days so we don't replay ancient mail. Widen the
-- interval if you want to recover further back. Only open INBOX threads the
-- poll can still see are actually reprocessed. Data cleanup, not a migration —
-- run once in the Supabase SQL editor.

begin;

-- PREVIEW — how many skipped threads will be re-queued.
select count(*) as classifier_skipped_to_requeue
from public.email_intake_log
where routed_via = 'classifier-skipped'
  and task_id is null
  and processed_at >= now() - interval '14 days';

-- 1) Drop the dedupe rows so the poll re-sees these threads.
delete from public.email_intake_log
where routed_via = 'classifier-skipped'
  and task_id is null
  and processed_at >= now() - interval '14 days';

-- 2) Drop the silent-skip audit rows (task_id=null, routed_via='unrouted',
--    review_reason IS NULL — the not-actionable drops, distinct from the
--    'no-candidates' and 'classifier-failed' parks which carry a review_reason).
--    Fresh routing_decisions rows are written when the poll reprocesses.
delete from public.routing_decisions
where task_id is null
  and routed_via = 'unrouted'
  and review_reason is null
  and created_at >= now() - interval '14 days';

-- Inspect the preview count above, then:
--   COMMIT;    -- to apply and let the next poll re-run them
-- or
--   ROLLBACK;  -- to back out
commit;
