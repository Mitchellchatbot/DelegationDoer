-- Agent connector (MCP at /api/mcp): Mitchell's own Claude agent reads the
-- business and makes a small set of edits through bearer keys (AGENT_API_KEYS).
-- Two tables back it. Both are service-role only — RLS on, no policies, like the
-- other brain tables — and every read/write goes through app code that gates on
-- the owner or a verified agent key.
--
-- APPLY THIS BEFORE deploying the connector code: every agent WRITE records an
-- agent_actions row first and refuses to act if that insert fails ("audit log
-- unavailable — nothing was changed"). The Growth Brain itself keeps working
-- without brain_instructions (it falls back to the hard-coded default rules).

-- Versioned core rules for the Growth Brain (src/lib/brain-instructions.ts).
-- Append-only: every edit and every rollback inserts a NEW row, and the newest
-- row (created_at, then id) is the active one. No row at all = the default rules
-- in code. Only the mandate + core rules live here; the source-specific rules
-- and the JSON output contract stay in code so an edit can't break the brief.
create table if not exists public.brain_instructions (
  id text primary key,
  rules text not null,
  note text,
  created_by text not null,           -- a user email, or "agent:<key name>"
  created_at timestamptz not null default now()
);

create index if not exists brain_instructions_created_idx
  on public.brain_instructions (created_at desc, id desc);

-- Audit trail of agent tool calls (src/lib/agent-audit.ts). A row is written
-- BEFORE the action runs (ok/result/error/finished_at null) and completed after,
-- so an action that crashed or timed out mid-way still shows up — as a row that
-- never finished. input has obvious secrets redacted before it's stored.
create table if not exists public.agent_actions (
  id text primary key,
  key_name text not null,             -- the AGENT_API_KEYS name that called
  tool text not null,
  input jsonb not null default '{}',
  ok boolean,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists agent_actions_created_idx
  on public.agent_actions (created_at desc);

alter table public.brain_instructions enable row level security;
alter table public.agent_actions      enable row level security;

notify pgrst, 'reload schema';

-- Result grid (the SQL editor swallows RAISE NOTICE): both tables should exist
-- with RLS on.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('brain_instructions', 'agent_actions')
order by c.relname;
