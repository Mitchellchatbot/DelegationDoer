-- Persistent memory for the AI brain: durable priorities, decisions, facts,
-- and preferences it carries across every chat and the daily brief. Owner-only
-- (Mitchell's operating memory); reads/writes are gated in app code.
create table if not exists brain_memories (
  id text primary key,
  content text not null,
  category text not null default 'fact', -- priority | decision | fact | preference
  created_by text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
