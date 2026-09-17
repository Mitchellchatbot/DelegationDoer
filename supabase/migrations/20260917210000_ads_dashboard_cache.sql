-- Last-good cache for the flaky ads dashboard reads (Meta + outbound board).
-- Every successful pull is written here; when the dashboard is overloaded and a
-- fresh read fails, the Scale Room falls back to the last good payload instead
-- of showing a blank. Keyed per read (e.g. "meta:7", "board").
create table if not exists ads_dashboard_cache (
  cache_key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
