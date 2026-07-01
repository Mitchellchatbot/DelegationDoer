-- Off-board (hard-delete) a teammate from the Leader Console.
--
-- Removing a user used to be a hand-run SQL purge (see
-- 20260516200000_purge_mock_seed_users.sql) because a plain
-- `delete from public.users` fails: almost every FK into public.users
-- is ON DELETE CASCADE / SET NULL, but two are not, and two array
-- columns aren't reached by FK cascades at all:
--   * tasks.creator_id       — ON DELETE RESTRICT  → reassign first
--   * task_extensions.user_id — NO ACTION (≈RESTRICT) → delete first
--   * sops.created_by        — NOT NULL + ON DELETE SET NULL: the cascade
--       would try to null a NOT NULL column and abort → reassign first
--   * activity_logs.mentioned_user_ids (text[])  → array_remove
--   * clients.assigned_user_ids        (text[])  → array_remove
--
-- This function does the reassign + deletes + array scrubs + the final
-- user delete atomically (single transaction — all or nothing). The
-- API route (DELETE /api/users/[id]) calls it via supabase.rpc() and
-- then deletes the matching auth.users login through the admin API
-- (auth_user_id is returned here so the caller knows which login to
-- remove; if left behind, the handle_new_auth_user() trigger would
-- recreate the app row on the user's next sign-in).

create or replace function public.offboard_user(
  target_user_id    text,
  successor_user_id text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  removed_auth_user_id uuid;
begin
  if target_user_id is null or successor_user_id is null then
    raise exception 'offboard_user: target and successor are both required';
  end if;
  if target_user_id = successor_user_id then
    raise exception 'offboard_user: successor must differ from the target';
  end if;

  -- Capture the login link before we delete the row. Also doubles as an
  -- existence check.
  select auth_user_id into removed_auth_user_id
  from public.users
  where id = target_user_id;
  if not found then
    raise exception 'offboard_user: no user with id %', target_user_id;
  end if;

  -- The successor inherits authored tasks + SOPs, so it must be a real
  -- user — otherwise those reassignments would fail on the FK with an
  -- opaque error. Fail fast with a clear one instead.
  perform 1 from public.users where id = successor_user_id;
  if not found then
    raise exception 'offboard_user: successor % does not exist', successor_user_id;
  end if;

  -- 1) Reassign authored tasks (creator_id RESTRICT) to the successor.
  update public.tasks
     set creator_id = successor_user_id
   where creator_id = target_user_id;

  -- 2) Task extensions have no ON DELETE clause (NO ACTION ≈ RESTRICT).
  delete from public.task_extensions
   where user_id = target_user_id;

  -- 2b) sops.created_by is NOT NULL but ON DELETE SET NULL — the cascade
  --     would violate the not-null constraint. Reassign to the successor
  --     (keeps the SOP + its authorship pointing at a real user).
  update public.sops
     set created_by = successor_user_id
   where created_by = target_user_id;

  -- 3) Array columns aren't reached by FK cascades — scrub the id out.
  update public.activity_logs
     set mentioned_user_ids = array_remove(mentioned_user_ids, target_user_id)
   where target_user_id = any(mentioned_user_ids);

  update public.clients
     set assigned_user_ids = array_remove(assigned_user_ids, target_user_id)
   where target_user_id = any(assigned_user_ids);

  -- 4) The user row itself. Every remaining FK is CASCADE or SET NULL,
  --    so this fans out cleanly.
  delete from public.users
   where id = target_user_id;

  return removed_auth_user_id;
end;
$$;

-- The DELETE route runs under the service role. Lock execute down to it
-- so no other (e.g. authenticated) surface can invoke the purge.
revoke all on function public.offboard_user(text, text) from public;
grant execute on function public.offboard_user(text, text) to service_role;
