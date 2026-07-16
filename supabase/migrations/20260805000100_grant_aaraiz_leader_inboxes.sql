-- Grant Aaraiz (andrew@scaledai.org) read access to Mujtaba's and Mitchell's
-- inboxes so he can triage on their behalf. This is a pure data grant — inbox
-- visibility is grant-based (inbox_assignments + space membership unioned in
-- visibleAccountIdsFor, src/lib/inbox-access.ts), so no role change is needed.
--
--   * Mitchell = "Boss's mail" (missive account 0092fb26-…), a PRIVATE inbox
--     (public.inbox_privacy). Space membership is the supported grant path for
--     it (see 20260704010000_boss_mail_grant_shaheer.sql). Handled by adding
--     Aaraiz to the existing space, resolved by name.
--
--   * Mujtaba = mike@scaledai.org. His inbox is NOT private and is NOT recorded
--     in any DelegationDoer grant table (inbox_assignments / inbox_privacy /
--     inbox_spaces) — the account id lives only in the Missive clone. The id
--     below was read from the clone's GET /api/accounts and confirmed to be
--     mike@scaledai.org (distinct from 5b31df31-… = websites@scaledai.org, the
--     Website team shared inbox — NOT what was requested). A direct
--     inbox_assignment is the correct grant for a non-private, unassigned inbox.
--
-- Aaraiz is resolved first and aborts loudly if missing. The Boss's-mail space
-- lookup is best-effort (RAISE NOTICE): if it can't be resolved, finish that one
-- grant via the leader-only manage UI (/inboxes/manage). Idempotent.
do $$
declare
  v_aaraiz   text;
  v_space_id text;
begin
  select id into v_aaraiz
    from public.users
   where email ilike 'andrew@scaledai.org'
   limit 1;
  if v_aaraiz is null then
    raise exception 'No user with email andrew@scaledai.org found in public.users — confirm the account';
  end if;

  -- Mitchell / Boss's mail — add Aaraiz to the private space.
  select id into v_space_id
    from public.inbox_spaces
   where name ilike 'boss%mail%'
   limit 1;
  if v_space_id is null then
    raise notice 'Boss''s mail space not found — grant Mitchell''s inbox to Aaraiz manually via /inboxes/manage';
  else
    insert into public.inbox_space_members (space_id, user_id)
    values (v_space_id, v_aaraiz)
    on conflict (space_id, user_id) do nothing;
  end if;

  -- Mujtaba (mike@scaledai.org) — direct assignment to his confirmed account.
  insert into public.inbox_assignments
    (id, user_id, missive_account_id, inbox_email, inbox_label, assigned_by)
  values
    (gen_random_uuid()::text, v_aaraiz,
     '6f9cb977-b950-4a38-8a03-40ff0251df50', 'mike@scaledai.org', 'Mujtaba', v_aaraiz)
  on conflict (user_id, missive_account_id) do nothing;
end $$;
