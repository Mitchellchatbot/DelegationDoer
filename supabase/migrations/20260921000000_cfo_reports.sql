-- Same-day dedupe + history for the morning CFO report DM (cfo-report-runner).
-- One row per NY date (id = cfo_<YYYY-MM-DD>); delivered_at set once sent.
create table if not exists public.cfo_reports (
  id           text primary key,
  report_date  text not null,
  month        text,
  margin_pct   numeric,
  on_track     boolean,
  gap_now      numeric,
  report       jsonb not null default '{}'::jsonb,
  slack_ts     text,
  delivered_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists cfo_reports_date_idx on public.cfo_reports (report_date desc);
