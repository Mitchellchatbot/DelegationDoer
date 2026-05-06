-- Image attachments on activity log entries (status changes / comments).

alter table public.activity_logs
  add column if not exists image_url text;

-- Storage bucket for ticket attachments. Public read so URLs from
-- activity_logs.image_url just work in <img> tags. Writes are gated to the
-- service_role (the /api/upload route uses it).
insert into storage.buckets (id, name, public)
values ('ticket-attachments', 'ticket-attachments', true)
on conflict (id) do nothing;

-- Permissive read on the bucket's objects (matches the bucket's public flag).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'ticket_attachments_public_read'
  ) then
    create policy "ticket_attachments_public_read" on storage.objects
      for select using (bucket_id = 'ticket-attachments');
  end if;
end $$;
