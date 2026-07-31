-- One-shot: flip is_admin = true on Sam (SEO department head).
--
-- Same stealth-admin pattern as the earlier Mecheal / Hasan / Farez+Tabrez
-- promotions (20260527000000, 20260618000000, 20260630000000). is_admin is
-- the stealth flag: full leader powers under the hood, regular role in the
-- UI. Sam was meant to have it from the start and was simply missed.
--
-- Symptom this fixes: the "Assign team" picker on /clients never rendered
-- for him. That surface gates on canManageAssignments() in
-- src/lib/inbox-access.ts, which is `role === 'leader' || isAdmin === true`
-- — and when it's false ClientTeamPicker renders a read-only chip instead
-- of the button, so there was no affordance to click at all.
--
-- IMPORTANT: only is_admin changes here. Unlike the original stealth-admin
-- migration (20260520000000), which also forced role = 'worker' for
-- Shaheer, Sam must STAY role = 'department_head'. 20260720000000 pins
-- every other SEO lead to 'worker' so the org chart has exactly one root;
-- demoting Sam would leave the SEO tree rootless. His departments,
-- managers and SOD/EOD flags are likewise left untouched.
--
-- Matched by EXACT lowered email. RAISE NOTICE confirms the count.

do $$
declare
  affected int;
begin
  update public.users
     set is_admin = true
   where lower(email) = 'sam@scaledai.org';

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify sam@scaledai.org exists.';
  elsif affected = 1 then
    raise notice 'is_admin set to true for Sam (1 row).';
  else
    raise notice 'is_admin flipped on % row(s) — expected 1; please verify.', affected;
  end if;
end $$;
