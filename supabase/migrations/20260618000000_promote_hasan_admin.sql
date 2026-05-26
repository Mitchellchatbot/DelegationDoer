-- One-shot: flip is_admin = true on Hasan's user row.
--
-- Same pattern as the earlier Mecheal Syed promotion. is_admin is the
-- stealth flag (full leader powers, regular role in UI); after this
-- runs, Hasan can see every department's tl;dv approvals + routing-
-- review queue while still appearing as "Department Head · Software"
-- in the topbar pill.
--
-- Match is permissive — likely email patterns + name ILIKE — but
-- restricted to scaledai.org so we can't accidentally catch an
-- unrelated user. RAISE NOTICE confirms which row(s) flipped.

do $$
declare
  affected int;
  matched_email text;
begin
  update public.users
     set is_admin = true
   where lower(email) = 'henry@scaledai.org'
      or lower(email) like '%hasan%@scaledai.org'
      or (lower(email) like '%@scaledai.org' and name ilike '%hasan%')
  returning email into matched_email;

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify Hasan''s email/name.';
  elsif affected = 1 then
    raise notice 'is_admin flipped on % (1 row).', matched_email;
  else
    raise notice 'is_admin flipped on % rows — please verify only Hasan was intended.', affected;
  end if;
end $$;
