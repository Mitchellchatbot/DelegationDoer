-- Owner switches for the Scale Room's two outside sources.
--
-- /scale and the Growth Brain read two other apps: the Facebook side from the
-- Finance app (/api/revenue) and our own Outbound funnel from the ads dashboard
-- (/api/outbound/summary). These let the owner turn either off from /scale —
-- off means no fetch, no card, and nothing about it in the brain's snapshot.
--
-- Two columns on the workspace_settings singleton (mirrors
-- low_site_score_threshold and overdue_archive_days). Default true, so both
-- sources stay on until someone switches one off. The app treats a missing row
-- as both on, and a FAILED read as both off (with a note on /scale) — so run
-- this before deploying the code that reads it, or /scale shows both off.
alter table public.workspace_settings
  add column if not exists scale_source_facebook boolean not null default true,
  add column if not exists scale_source_outbound boolean not null default true;

notify pgrst, 'reload schema';

select id, scale_source_facebook, scale_source_outbound from public.workspace_settings;
