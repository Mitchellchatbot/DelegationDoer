-- Persisted output of the Growth Brain: the structured CEO brief (the #1 growth
-- constraint + PROTECT items + GROW/Scale-Opportunity items). Owner-only via app
-- gates on /api/brain/growth and the /scale page.
create table if not exists brain_growth (
  id text primary key,
  data jsonb not null,
  generated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
