-- One-shot: flip is_admin = true on Mecheal Syed's user row.
--
-- Spelling of the first name is uncertain (Mecheal / Mechael / Michael)
-- so the match is permissive — ILIKE on a few likely email/name
-- combinations, restricted to scaledai.org so we can't accidentally
-- catch an unrelated user. The RAISE NOTICE prints which row(s) got
-- flipped so the operator can verify after running.
--
-- Same pattern as the earlier shaheerkhosa6 leader promotion. is_admin
-- is the stealth flag (full leader powers, regular role in UI); use
-- this when you want admin authority without publicly bumping someone
-- to Leader.

do $$
declare
  affected int;
  matched_email text;
begin
  update public.users
     set is_admin = true
   where lower(email) like '%mecheal%@scaledai.org'
      or lower(email) like '%mechael%@scaledai.org'
      or lower(email) like '%michael%@scaledai.org'
      or (lower(email) like '%@scaledai.org' and (
            name ilike '%mecheal%syed%'
         or name ilike '%mechael%syed%'
         or name ilike '%michael%syed%'
      ))
  returning email into matched_email;

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify Mecheal''s email/name.';
  elsif affected = 1 then
    raise notice 'is_admin flipped on % (1 row).', matched_email;
  else
    raise notice 'is_admin flipped on % rows — please verify only Mecheal was intended.', affected;
  end if;
end $$;
