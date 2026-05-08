-- Notion-style first-class task fields + org-wide custom fields.
--
-- Built-ins added to tasks: client_email, client_folder_url, staging_server,
-- markup_link, hosting_access, missive_thread_url. These are concrete,
-- recurring fields the team uses on every client project, so they live as
-- columns rather than entries in the custom-fields system.
--
-- Custom fields: a separate `task_custom_fields` table stores org-wide
-- field definitions (name + type + options). Each task carries a `custom`
-- JSONB column mapping field_id → value. JSONB beats a per-value table
-- here because the read pattern is "give me all fields for this task" —
-- a single row read instead of an N-row join.

alter table tasks
  add column if not exists client_email      text,
  add column if not exists client_folder_url text,
  add column if not exists staging_server    text,
  add column if not exists markup_link       text,
  add column if not exists hosting_access    text,
  add column if not exists missive_thread_url text,
  -- Per-task custom-field values: { [field_id]: value }. Server validates
  -- shape on write; client renders with the field def's `type`.
  add column if not exists custom            jsonb not null default '{}'::jsonb;

create table if not exists task_custom_fields (
  id text primary key,
  name text not null,
  -- Allowed: text | number | url | date | checkbox | select | multiselect.
  type text not null check (
    type in ('text', 'number', 'url', 'date', 'checkbox', 'select', 'multiselect')
  ),
  -- For select / multiselect: array of { value, label, color } objects.
  -- Null for the simpler types.
  options jsonb,
  -- Display order in admin + task detail. Lower numbers render first.
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists task_custom_fields_position_idx on task_custom_fields(position);
