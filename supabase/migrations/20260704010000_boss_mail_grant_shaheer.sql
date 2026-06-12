-- Grant stealth-admin shaheer access to the private "Boss's Mail" inbox.
--
-- Boss's Mail (mitchell@scaledai.org) is a PRIVATE inbox: by design it is
-- hidden from everyone except its owner, direct assignees, and members of its
-- space — admins and stealth admins included (see inbox_privacy +
-- visibleAccountIdsFor in src/lib/inbox-access.ts). Space membership is the
-- supported way to grant access, and it also makes the space render (and, with
-- the position pin, sit at the top) in that user's sidebar.
--
-- Idempotent. Raises (and aborts) if the space or user can't be resolved, so a
-- bad name/email surfaces immediately instead of silently doing nothing.
do $$
declare
  v_space_id text;
  v_user_id  text;
begin
  select id into v_space_id
    from public.inbox_spaces
   where name ilike 'boss%mail%'
   limit 1;
  if v_space_id is null then
    raise exception 'Boss''s mail space not found — no inbox_spaces.name matches the boss-mail pattern';
  end if;

  select id into v_user_id
    from public.users
   where email ilike '%shaheer%'
   limit 1;
  if v_user_id is null then
    raise exception 'No user with "shaheer" in their email found in public.users — confirm the account';
  end if;

  insert into public.inbox_space_members (space_id, user_id)
  values (v_space_id, v_user_id)
  on conflict (space_id, user_id) do nothing;
end $$;
