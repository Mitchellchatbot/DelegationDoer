-- Per-client point person.
--
-- clients.team_id already names the OWNING team (Websites + 4 SEO
-- sub-teams). assigned_user_id narrows that further to one specific
-- person — the lead/owner inside the team. Optional; null = the team
-- owns the client collectively.
alter table public.clients
  add column if not exists assigned_user_id text references public.users(id) on delete set null;

create index if not exists clients_assigned_user_id_idx
  on public.clients (assigned_user_id)
  where assigned_user_id is not null;
