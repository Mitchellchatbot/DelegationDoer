-- Follow-up to 20260507300000: the original rename migration missed the
-- `blocks_ticket_ids` text[] column on tasks. Code now queries
-- `blocks_task_ids` and Supabase returns "column not found in schema cache"
-- until this lands. Idempotent — uses information_schema lookup.

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'tasks'
       and column_name = 'blocks_ticket_ids'
  ) then
    alter table public.tasks
      rename column blocks_ticket_ids to blocks_task_ids;
  end if;
end $$;
