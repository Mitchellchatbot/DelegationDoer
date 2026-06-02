-- One-shot: flip daily_prompts_enabled = false for Sam and Mujtaba.
--
-- Sam and Mujtaba don't run the SOD/EOD ritual themselves, so the
-- bookend card on /home and the widget's EOD nudge shouldn't pop up
-- for them. Same per-user opt-out the column was added for in
-- 20260623000000 and applied to Mitchell in 20260625000000.
--
-- Matched by EXACT name (the canonical names the org-structure seed
-- in 20260528000001 uses), restricted to scaledai.org. Exact match —
-- NOT ilike '%sam%' — because a separate user 'Samir G' exists and a
-- substring match would wrongly catch him. RAISE NOTICE confirms the
-- affected count.

do $$
declare
  affected int;
begin
  update public.users
     set daily_prompts_enabled = false
   where lower(email) like '%@scaledai.org'
     and name in ('Sam', 'Mujtaba');

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify Sam/Mujtaba''s name + email domain.';
  elsif affected = 2 then
    raise notice 'daily_prompts_enabled set to false for Sam and Mujtaba (2 rows).';
  else
    raise notice 'daily_prompts_enabled flipped on % row(s) — expected 2 (Sam + Mujtaba); please verify.', affected;
  end if;
end $$;
