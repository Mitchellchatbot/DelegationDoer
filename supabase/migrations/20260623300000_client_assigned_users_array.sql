-- Multi-select point people on a client.
--
-- The single assigned_user_id (20260623200000) wasn't enough — leaders
-- need to assign multiple owners per client (e.g. an SEO sub-team where
-- the lead AND a writer both work the account). Switch to an array.
--
-- Backfill from the singular column so existing data is preserved. The
-- old column stays for one release as a fallback read path; new code
-- writes only to the array.
alter table public.clients
  add column if not exists assigned_user_ids text[] not null default '{}'::text[];

update public.clients
  set assigned_user_ids = array[assigned_user_id]
  where assigned_user_id is not null
    and (assigned_user_ids is null or array_length(assigned_user_ids, 1) is null);

-- GIN index so a future "clients owned by user X" query stays cheap as
-- the table grows.
create index if not exists clients_assigned_user_ids_idx
  on public.clients using gin (assigned_user_ids);
