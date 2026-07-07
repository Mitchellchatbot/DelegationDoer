-- Friday day-end "clients emailed this week" Slack push (clients-emailed-weekly
-- runner) needs a same-UTC-day dedupe stamp so two ticks inside the 7pm NY hour
-- (and the Vercel-cron / Railway-loop overlap) can't double-DM Sam & Mitchell.
-- Mirrors workspace_settings.last_eod_recap_at, which the daily recap uses the
-- same way.
--
-- No other schema change is needed: the summary is derived live from the SENT
-- folder + email_drafts + bulk_email_threads, all of which already exist, and
-- client↔email attribution is participant-based (no stored FK).

alter table public.workspace_settings
  add column if not exists last_clients_emailed_push_at timestamptz;
