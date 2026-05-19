-- Wire Emily Carter (= "Komal" on the SEO whiteboard) under Bismah
-- as a direct report. Gul Afroz already points at Bismah per the
-- earlier diagnostic — this completes Bismah's reports list so her
-- assignment dropdown shows both Gul and Emily.
--
-- DO block so we can print which row got flipped, with a NOTICE
-- when zero matches (lets the operator catch a name spelling
-- mismatch without re-running queries).

do $$
declare
  bismah_id text;
  affected int;
begin
  select id into bismah_id
  from public.users
  where name ilike '%bismah%'
  limit 1;

  if bismah_id is null then
    raise notice 'No user matching %bismah% — abort.';
    return;
  end if;

  update public.users
     set manager_user_id = bismah_id
   where name ilike '%emily%carter%';

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No Emily Carter row found — verify the name spelling.';
  else
    raise notice 'Set manager_user_id = % on % Emily Carter row(s).', bismah_id, affected;
  end if;
end $$;
