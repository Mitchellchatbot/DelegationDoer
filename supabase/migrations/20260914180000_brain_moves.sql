-- Persisted output of the Scale Room "Moves to scale" engine: the brain's
-- strategic recommendations, so the latest set shows on load. Owner-only via
-- app-code gates on /api/brain/moves and the /scale page.
create table if not exists brain_moves (
  id text primary key,
  moves jsonb not null,
  headline text,
  generated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
