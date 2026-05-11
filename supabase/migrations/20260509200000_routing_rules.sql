-- Responsibilities — keyword-driven routing rules. When a new task lands
-- (typed in the popdown OR auto-created from an email), the system first
-- checks these rules. The first matching rule wins (priority desc).
--
-- Each rule names either a specific user, a department (whose head
-- becomes the assignee), or both. If both, user takes precedence.
create table if not exists routing_rules (
  id text primary key,
  label text not null,                -- e.g. "Tax filings"
  -- Lowercased substrings to match against task title + body. Any-of
  -- semantics: at least one keyword must appear for the rule to fire.
  keywords text[] not null,
  assignee_user_id text references users(id) on delete cascade,
  department_id text references departments(id) on delete set null,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  -- Either an assignee or a department must be set, otherwise the rule
  -- has no target and would silently no-op.
  check (assignee_user_id is not null or department_id is not null),
  check (array_length(keywords, 1) > 0)
);

create index if not exists routing_rules_priority_idx on routing_rules(priority desc, created_at);
