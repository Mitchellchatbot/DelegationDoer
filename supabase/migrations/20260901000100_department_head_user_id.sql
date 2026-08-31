-- Give departments an explicit head.
--
-- WHY
--
-- DD has no per-department role. users.role is GLOBAL, so the moment somebody
-- who leads Website joins a second department they also read as a
-- "department_head" inside it. Every question of the form "who runs this team?"
-- was answered by scanning department_members for role='department_head' and
-- taking the first match -- with no ORDER BY, so where several members
-- qualified the answer could differ between runs.
--
-- That was survivable only because each department had exactly one head. It
-- stops being survivable with Facebook, whose roster (20260901000200) includes
-- three people who already head other teams. Without this column Facebook would
-- appear to be led by whichever of the three Postgres happened to return first,
-- and api/sod/submit would DM all three every morning that any other Facebook
-- member filed their start-of-day update -- notifications for a team none of
-- them actually runs.
--
-- head_user_id records who genuinely owns a department. NULL is a real answer,
-- not a missing one: intake falls back to the skill ranker or routing review
-- instead of guessing, and SOD notifications skip the department entirely.
--
-- BACKFILL IS DELIBERATELY CONSERVATIVE
--
-- A department is auto-assigned its head ONLY when exactly one of its members
-- carries role='department_head'. That reproduces today's behaviour exactly for
-- every department that already has a single clear head, while leaving Facebook
-- NULL -- which is the whole point. Anything ambiguous (zero heads, or several)
-- is left NULL and reported, for a human to set in the Leader Console.
--
-- Re-running never overwrites a head that has already been set, so this is safe
-- to apply more than once.
--
-- CHANGES NO ROLES and adds/removes no memberships. `on delete set null` means
-- off-boarding a head clears the pointer rather than blocking the delete --
-- matching how users.manager_user_id already behaves.

alter table public.departments
  add column if not exists head_user_id text
    references public.users(id) on delete set null;

do $$
declare
  rec       record;
  n_heads   int;
  n_set     int := 0;
  n_skipped int := 0;
begin
  raise notice '=== departments.head_user_id backfill ===';

  for rec in select id, name from public.departments order by name loop
    select count(*) into n_heads
      from public.department_members dm
      join public.users u on u.id = dm.user_id
     where dm.department_id = rec.id
       and u.role = 'department_head';

    if n_heads = 1 then
      update public.departments d
         set head_user_id = (
               select u.id
                 from public.department_members dm
                 join public.users u on u.id = dm.user_id
                where dm.department_id = rec.id
                  and u.role = 'department_head'
                limit 1)
       where d.id = rec.id
         and d.head_user_id is null;      -- never clobber a hand-set head
      if found then
        n_set := n_set + 1;
        raise notice '  % -- head set from its single department_head member', rec.name;
      else
        raise notice '  % -- head already set, left alone', rec.name;
      end if;

    elsif n_heads = 0 then
      n_skipped := n_skipped + 1;
      raise warning '  % -- NO member carries role=department_head; left NULL. If this is an established department its start-of-day DMs and intake auto-assignment will STOP once the code deploys.', rec.name;

    else
      n_skipped := n_skipped + 1;
      raise warning '  % -- % members carry role=department_head, so who leads it is ambiguous; left NULL. Intake will route to the ranker / routing review and SOD will not DM anyone for this department until a head is set.',
        rec.name, n_heads;
    end if;
  end loop;

  raise notice '--- result: % department(s) assigned, % left without a head ---', n_set, n_skipped;

  for rec in
    select d.name, u.name as head_name, u.email as head_email
      from public.departments d
      left join public.users u on u.id = d.head_user_id
     order by d.name
  loop
    raise notice '   . % -> %', rec.name,
      coalesce(rec.head_name || ' <' || rec.head_email || '>', '(no head)');
  end loop;

  -- HARD STOP. These four departments have live SOD DMs and live intake
  -- auto-assignment today. A NULL head on any of them silently switches both
  -- off the moment the accompanying code deploys -- and because this project
  -- applies migrations by hand through the Supabase SQL editor, which does not
  -- reliably surface NOTICE/WARNING output, a log line is not a control. Only
  -- an exception is guaranteed to be seen.
  --
  -- The list is an explicit allowlist rather than "every department except
  -- dep_facebook" for two reasons: dep_facebook is MEANT to end up NULL, and a
  -- blanket rule would turn every future empty department into a failing
  -- migration re-run.
  --
  -- Worth knowing why this is not hypothetical: no migration in this repo ever
  -- inserts Talha Ali's dep_mkt membership (20260528000001 sets his role and
  -- deletes Mujtaba's marketing row, but never adds Talha's), so if it was
  -- never created through the UI, Marketing genuinely has zero head-role
  -- members and would fail here -- which is the point.
  if exists (
    select 1 from public.departments d
     where d.id in ('dep_seo', 'dep_web', 'dep_software', 'dep_mkt')
       and d.head_user_id is null
  ) then
    raise exception
      'Backfill left an established department without a head: %. Its start-of-day Slack DMs and intake auto-assignment would STOP. Set departments.head_user_id for it (Leader Console -> Departments, or by hand) and re-run.',
      (select string_agg(d.id, ', ' order by d.id)
         from public.departments d
        where d.id in ('dep_seo', 'dep_web', 'dep_software', 'dep_mkt')
          and d.head_user_id is null);
  end if;
end $$;
