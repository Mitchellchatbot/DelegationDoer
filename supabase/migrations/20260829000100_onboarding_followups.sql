-- Follow-ups to the client onboarding forms (20260828000100).
--
-- Two columns, both additive, both nullable. Nothing existing is altered and
-- nothing is backfilled, so this is safe to run against a database that already
-- has onboarding links and answers in it.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

-- ---------------------------------------------------------------------------
-- Send the completion email once, and only once.
-- ---------------------------------------------------------------------------
-- The finish button gets pressed more than once in practice: a double click, a
-- client stepping back through the flow to re-read a step and pressing finish
-- again, a client reopening the link a week later to check what they sent. None
-- of those should put a second email in their inbox.
--
-- A stamp on the link rather than a boolean, because "when did we tell them"
-- turns out to be the question the team actually asks when a client says they
-- never heard anything.
alter table public.client_onboarding_links
  add column if not exists completion_email_sent_at timestamptz;

-- ---------------------------------------------------------------------------
-- Which mailbox that email goes out from.
-- ---------------------------------------------------------------------------
-- A missiveclone account id. Held here rather than in an env var so it can be
-- picked from a dropdown on /clients/onboarding -- account ids are opaque and
-- live in the clone, so asking anyone to find one by hand is asking for the
-- wrong id to be pasted in.
--
-- Nullable on purpose, and the sender treats null as "skip and log". Onboarding
-- has to keep working on a deployment where nobody has chosen a mailbox yet;
-- the client finishing is far more important than the confirmation email.
alter table public.workspace_settings
  add column if not exists onboarding_from_account_id text;
