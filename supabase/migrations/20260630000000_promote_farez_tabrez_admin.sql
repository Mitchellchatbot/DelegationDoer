-- One-shot: flip is_admin = true on Farez Khan + Tabrez Khan.
--
-- Same stealth-admin pattern as the earlier Mecheal / Hasan promotions
-- (20260527000000, 20260618000000). is_admin is the stealth flag: full
-- leader powers under the hood, regular role in the UI. Their public
-- `role`, departments, managers and SOD/EOD flags are left untouched;
-- only is_admin changes, and only on these two rows.
--
-- Matched by EXACT lowered email (the two addresses below). NOTE: Farez
-- uses a personal gmail (farezomair1996@gmail.com), so we deliberately
-- do NOT restrict to scaledai.org. RAISE NOTICE confirms the count.

do $$
declare
  affected int;
begin
  update public.users
     set is_admin = true
   where lower(email) in ('tabrez@scaledai.org', 'farezomair1996@gmail.com');

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify Farez/Tabrez emails.';
  elsif affected = 2 then
    raise notice 'is_admin set to true for Tabrez and Farez (2 rows).';
  else
    raise notice 'is_admin flipped on % row(s) — expected 2; please verify.', affected;
  end if;
end $$;
