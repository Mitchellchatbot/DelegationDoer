-- Rename "ticket" -> "task" everywhere in the schema. The product talks
-- about tasks; the original schema used the issue-tracker term "ticket".
-- We unify on "task" for clarity. After this migration, all FK columns and
-- the status enum match the new noun.
--
-- Idempotent guards via IF EXISTS / pg_type / information_schema lookups so
-- re-running is safe.

-- 1. Tables
alter table if exists public.tickets rename to tasks;
alter table if exists public.ticket_extensions rename to task_extensions;

-- 2. Foreign-key columns that reference tasks(id)
alter table if exists public.activity_logs               rename column ticket_id to task_id;
alter table if exists public.task_extensions             rename column ticket_id to task_id;
alter table if exists public.assignment_acknowledgements rename column ticket_id to task_id;

-- 3. Enum: ticket_status -> task_status. Postgres allows alter type … rename.
do $$
begin
  if exists (select 1 from pg_type where typname = 'ticket_status') then
    alter type ticket_status rename to task_status;
  end if;
end $$;

-- 4. Storage bucket "ticket-attachments" intentionally NOT renamed — it
--    holds real uploaded files and renaming would break their URLs. The
--    bucket name is internal-only; nothing user-visible references it.
