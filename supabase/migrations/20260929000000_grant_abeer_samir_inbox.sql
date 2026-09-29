-- Grant Abeer (aiden@scaledai.org) access to Samir G's (samir@scaledai.org)
-- inbox in DelegationDoer.
--
-- Pure data grant — inbox visibility is grant-based, so no role change is
-- needed and none is wanted. Abeer is a worker (SEO, reporting to Samir per
-- 20260720000000_seo_org_structure_email_keyed.sql), and the worker branch of
-- visibleAccountIdsFor (src/lib/inbox-access.ts) resolves to "own direct
-- inbox_assignments + any space the user belongs to". A direct
-- inbox_assignment is therefore the minimal correct grant: it opens exactly
-- Samir's inbox and nothing else.
--
-- Deliberately NOT a space grant. Space membership hands over every account in
-- the space (see 20260704010000_boss_mail_grant_shaheer.sql), which would
-- over-grant here. It is the right tool only for a private inbox that has no
-- other grant path.
--
-- Privacy is handled either way: should samir@ be (or later become) a private
-- inbox, a direct assignment still grants it — privateExclusionsFor() spares
-- the actor when `assignedIds.has(accountId)`. (The prose header on
-- 20260703000000_inbox_privacy.sql claims an assignment does NOT override
-- privacy; the code disagrees and the code is what runs.)
--
-- Resolving the account id: missive_account_id lives in the Missive clone, not
-- in DD, so it must never be typed from memory. Rather than paste an id that
-- cannot be verified from this repo, this migration resolves it from DD's own
-- inbox_assignments.inbox_email — the same table syncMissiveOwnership() mirrors
-- Missive's account ownership into. If Samir's inbox has ever been connected
-- or synced, the id is already there and is self-verifying. If it is not, the
-- run ABORTS with instructions rather than guessing.
--
-- Idempotent, and safe to re-run after an aborted attempt.
do $$
declare
  -- Escape hatch: if auto-resolution aborts, read Samir's account id from the
  -- clone's GET /api/accounts (match on email = samir@scaledai.org), paste it
  -- here, and re-run. Leave null to resolve from DD.
  v_account_override constant text := null;

  v_abeer        text;
  v_match_count  int;
  v_account_id   text;
  v_inbox_email  text;
  v_inbox_label  text;
begin
  -- 1. Resolve Abeer. Exact email is the preferred key; the name fallback
  --    exists only because DD addresses are aliases that drift (aiden@ = Abeer).
  --    Ambiguity aborts instead of picking a winner.
  select id into v_abeer
    from public.users
   where lower(email) = 'aiden@scaledai.org'
   limit 1;

  if v_abeer is null then
    select count(*) into v_match_count
      from public.users
     where name ilike '%abeer%';

    if v_match_count = 0 then
      raise exception 'No DD user with email aiden@scaledai.org, and no user whose name contains "abeer". Confirm Abeer''s account before re-running.';
    elsif v_match_count > 1 then
      raise exception '% DD users have "abeer" in their name and none has email aiden@scaledai.org. Resolve the right account by hand rather than guessing.', v_match_count;
    end if;

    select id into v_abeer
      from public.users
     where name ilike '%abeer%'
     limit 1;

    raise warning 'aiden@scaledai.org did not match; fell back to a name match for Abeer.';
  end if;

  -- 2. Resolve Samir's Missive account id.
  if v_account_override is not null then
    v_account_id  := v_account_override;
    v_inbox_email := 'samir@scaledai.org';
    v_inbox_label := 'Samir G';
  else
    select count(distinct missive_account_id) into v_match_count
      from public.inbox_assignments
     where lower(inbox_email) = 'samir@scaledai.org';

    if v_match_count = 0 then
      raise exception 'Samir''s inbox (samir@scaledai.org) is not recorded in public.inbox_assignments, so its Missive account id cannot be resolved from DD. Read the id from the clone''s GET /api/accounts, set v_account_override at the top of this migration, and re-run. Do not guess the id.';
    elsif v_match_count > 1 then
      raise exception 'samir@scaledai.org maps to % distinct Missive account ids in inbox_assignments. Pick the right one from the clone''s GET /api/accounts and set v_account_override.', v_match_count;
    end if;

    select missive_account_id, inbox_email, inbox_label
      into v_account_id, v_inbox_email, v_inbox_label
      from public.inbox_assignments
     where lower(inbox_email) = 'samir@scaledai.org'
     limit 1;
  end if;

  -- 3. Grant. assigned_by stays null: this was granted by migration, not by a
  --    person, and null is what syncMissiveOwnership() writes for the same case.
  insert into public.inbox_assignments
    (id, user_id, missive_account_id, inbox_email, inbox_label, assigned_by)
  values
    (gen_random_uuid()::text, v_abeer, v_account_id,
     coalesce(v_inbox_email, 'samir@scaledai.org'),
     coalesce(v_inbox_label, 'Samir G'),
     null)
  on conflict (user_id, missive_account_id) do nothing;
end $$;

-- Verification grid. RAISE NOTICE is invisible in the Supabase SQL editor, so
-- anything the operator needs to READ has to be a SELECT, and it has to be the
-- LAST statement in the file. Expect a row for Abeer alongside Samir's own.
select
  u.name                  as grantee,
  u.email                 as grantee_email,
  ia.inbox_email          as granted_inbox,
  ia.missive_account_id,
  case when p.missive_account_id is null then 'no' else 'yes' end as inbox_private,
  ia.created_at
from public.inbox_assignments ia
join public.users u on u.id = ia.user_id
left join public.inbox_privacy p on p.missive_account_id = ia.missive_account_id
where lower(ia.inbox_email) = 'samir@scaledai.org'
order by ia.created_at desc;
