-- Phase 1 of auth: link Supabase Auth users (auth.users) to our application's
-- user rows (public.users). Each app user has at most one auth identity.
--
-- Reconciliation strategy: when a new auth.users row is inserted, the trigger
-- below tries to match by email to an existing public.users row (so signing
-- up as shaheerkhosa6@gmail.com automatically becomes u_1). If no match, a
-- new public.users row is created with role=worker.

alter table public.users
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create unique index if not exists users_auth_user_id_key
  on public.users (auth_user_id)
  where auth_user_id is not null;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_id text;
  new_id     text;
  display    text;
begin
  -- Pick a display name: signup metadata > local-part of email.
  display := coalesce(
    nullif(new.raw_user_meta_data ->> 'name', ''),
    initcap(replace(split_part(new.email, '@', 1), '.', ' '))
  );

  -- 1) Try to link to an existing app user by email (e.g. seeded mock users).
  select id into matched_id
    from public.users
   where lower(email) = lower(new.email)
     and auth_user_id is null
   limit 1;

  if matched_id is not null then
    update public.users
       set auth_user_id = new.id
     where id = matched_id;
    return new;
  end if;

  -- 2) No match: create a fresh worker row.
  -- Generate a stable short id from the auth user's UUID.
  new_id := 'u_a_' || substring(replace(new.id::text, '-', ''), 1, 10);

  insert into public.users (id, name, email, role, auth_user_id)
  values (new_id, display, new.email, 'worker', new.id)
  on conflict (email) do update
    set auth_user_id = new.id
   where public.users.auth_user_id is null;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
