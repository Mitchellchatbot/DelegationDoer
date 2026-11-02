-- Grant Leizel (leizel@scaledai.org) access to the software@scaledai.org inbox.
--
-- Data-only grant. A direct inbox_assignment opens exactly this one inbox, and
-- it also works if the inbox is private (privateExclusionsFor spares assignees,
-- src/lib/inbox-access.ts). No role change is needed.
--
-- The Missive account id comes from missive.email_accounts, the clone's own
-- table in this same Supabase project. inbox_assignments can't supply it because
-- nobody holds software@ yet. The lookup only accepts an account in a clone
-- workspace DD already uses, since DD can't list inboxes from any other. It reads
-- non-secret columns only: this table also holds mailbox passwords and OAuth tokens.
--
-- Idempotent. Apply by hand in the Supabase SQL editor.
do $$
declare
  v_account_override constant text := null;

  v_user_id    text;
  v_count      int;
  v_account_id text;
  v_email      text;
  v_label      text;
  v_total      int;
  v_near       text;
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
    if to_regclass('missive.email_accounts') is null then
      raise exception 'missive.email_accounts is not in this database. Sign in to DD as a leader, open https://operations.scaledai.org/api/inboxes, copy the id for software@scaledai.org into v_account_override, and re-run.';
    end if;

    select count(*), min(ea.id), min(ea.email), min(ea.display_name)
      into v_count, v_account_id, v_email, v_label
      from missive.email_accounts ea
     where lower(ea.email) = 'software@scaledai.org'
       and ea.workspace_id in (
         select a.workspace_id
           from missive.email_accounts a
           join public.inbox_assignments ia on ia.missive_account_id = a.id
       );

    if v_count = 0 then
      select count(*),
             string_agg(a.email, ', ' order by a.email)
               filter (where a.email ilike '%soft%' or a.display_name ilike '%soft%')
        into v_total, v_near
        from missive.email_accounts a;

      raise exception 'software@scaledai.org is not a connected inbox in DD, so there is nothing to grant. The clone has % inboxes; addresses or names containing "soft": %. If it is a mailing list or alias, add Leizel in the email admin console. If it should be an inbox, connect it first.', v_total, coalesce(v_near, 'none');
    elsif v_count > 1 then
      raise exception 'software@scaledai.org matches % connected inboxes. Copy the right id from https://operations.scaledai.org/api/inboxes into v_account_override and re-run.', v_count;
    end if;
  end if;

  -- 3. Grant. assigned_by stays null, as syncMissiveOwnership() writes it.
  insert into public.inbox_assignments
    (id, user_id, missive_account_id, inbox_email, inbox_label, assigned_by)
  values
    (gen_random_uuid()::text, v_user_id, v_account_id,
     coalesce(v_email, 'software@scaledai.org'), v_label, null)
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
