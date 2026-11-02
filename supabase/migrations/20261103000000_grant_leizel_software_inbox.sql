-- Grant Leizel (leizel@scaledai.org) access to the software@scaledai.org inbox.
--
-- Data-only grant. A direct inbox_assignment opens exactly this one inbox, and
-- it also works if the inbox is private (privateExclusionsFor spares assignees,
-- src/lib/inbox-access.ts). No role change is needed.
--
-- The Missive account id lives in the clone, so it is never typed from memory:
-- it is read from inbox_assignments.inbox_email. If nobody holds this inbox yet,
-- the run aborts. Read the id from the clone's GET /api/accounts, set
-- v_account_override below, and re-run.
--
-- Idempotent. Apply by hand in the Supabase SQL editor.
do $$
declare
  v_account_override constant text := null;

  v_user_id    text;
  v_count      int;
  v_account_id text;
  v_label      text;
begin
  -- 1. Resolve Leizel: exact email first, then a name match only if it is unique.
  select id into v_user_id
    from public.users
   where lower(email) = 'leizel@scaledai.org'
   limit 1;

  if v_user_id is null then
    select count(*) into v_count
      from public.users
     where name ilike '%leizel%';

    if v_count <> 1 then
      raise exception 'No DD user has email leizel@scaledai.org, and % users have "leizel" in their name. Confirm the account before re-running.', v_count;
    end if;

    select id into v_user_id
      from public.users
     where name ilike '%leizel%';
  end if;

  -- 2. Resolve the inbox's Missive account id.
  if v_account_override is not null then
    v_account_id := v_account_override;
  else
    select count(distinct missive_account_id) into v_count
      from public.inbox_assignments
     where lower(inbox_email) = 'software@scaledai.org';

    if v_count = 0 then
      raise exception 'software@scaledai.org is not in public.inbox_assignments, so its Missive account id cannot be resolved from DD. Read the id from the clone''s GET /api/accounts, set v_account_override at the top of this block, and re-run. Do not guess the id.';
    elsif v_count > 1 then
      raise exception 'software@scaledai.org maps to % Missive account ids in inbox_assignments. Pick the right one from the clone''s GET /api/accounts and set v_account_override.', v_count;
    end if;

    select missive_account_id, inbox_label
      into v_account_id, v_label
      from public.inbox_assignments
     where lower(inbox_email) = 'software@scaledai.org'
     limit 1;
  end if;

  -- 3. Grant. assigned_by stays null, as syncMissiveOwnership() writes it.
  insert into public.inbox_assignments
    (id, user_id, missive_account_id, inbox_email, inbox_label, assigned_by)
  values
    (gen_random_uuid()::text, v_user_id, v_account_id,
     'software@scaledai.org', v_label, null)
  on conflict (user_id, missive_account_id) do nothing;
end $$;

-- Report. The SQL editor hides RAISE NOTICE and shows only the last result, so
-- this has to stay the final statement.
--
-- The !! CHECK row covers the one side effect beyond read access. The email-draft
-- approve route falls back to a user's OLDEST inbox_assignment for the From:
-- account when a draft has no account pinned. If software@ is Leizel's only
-- assignment, Leizel's unpinned drafts would send as software@.
with leizel as (
  select id, name, email
    from public.users
   where lower(email) = 'leizel@scaledai.org'
      or (name ilike '%leizel%'
          and not exists (select 1 from public.users
                           where lower(email) = 'leizel@scaledai.org'))
)
select sort_key, section, person, inbox, created_at
from (
  select 0 as sort_key,
         '!! CHECK' as section,
         'software@ is Leizel''s only inbox assignment, so drafts with no pinned account would send AS software@. Pick the From account on each draft: an inbox connected later sorts after this row and does not change the fallback.' as person,
         null::text as inbox,
         null::timestamptz as created_at
   where (select count(*)
            from public.inbox_assignments ia
            join leizel l on l.id = ia.user_id) = 1

  union all

  select 1, 'can read software@', u.name || ' <' || u.email || '>',
         ia.inbox_email, ia.created_at
    from public.inbox_assignments ia
    join public.users u on u.id = ia.user_id
   where lower(ia.inbox_email) = 'software@scaledai.org'

  union all

  select 2, 'leizel''s inboxes', l.name || ' <' || l.email || '>',
         ia.inbox_email, ia.created_at
    from public.inbox_assignments ia
    join leizel l on l.id = ia.user_id
) report
order by sort_key, created_at;
