-- One-shot: flip daily_prompts_enabled = false for Farez and Tabrez.
--
-- Completes the SOD/EOD opt-out cohort. Mitchell (20260625000000) and
-- Sam + Mujtaba (20260626000000) are already flipped; this adds the two
-- SEO pod leads who likewise don't run the daily ritual themselves, so
-- the welcome/priority modal, the /home bookend card, and the widget's
-- EOD nudge should all stay quiet for them. Same per-user opt-out the
-- column was added for in 20260623000000.
--
-- Matched by EXACT full name (the canonical names the org-structure seed
-- in 20260528000001 / secondary-manager migration 20260530000000 use:
-- 'Farez Khan', 'Tabrez Khan'). NOTE: unlike the Mitchell/Sam/Mujtaba
-- migrations we do NOT restrict to scaledai.org — Farez's row uses a
-- personal gmail (farezomair1996@gmail.com), so a domain filter would
-- wrongly skip him. Full-name match is specific enough on its own.
-- RAISE NOTICE confirms the count.

do $$
declare
  affected int;
begin
  update public.users
     set daily_prompts_enabled = false
   where name in ('Farez Khan', 'Tabrez Khan');

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify Farez/Tabrez''s name + email domain.';
  elsif affected = 2 then
    raise notice 'daily_prompts_enabled set to false for Farez and Tabrez (2 rows).';
  else
    raise notice 'daily_prompts_enabled flipped on % row(s) — expected 2 (Farez + Tabrez); please verify.', affected;
  end if;
end $$;
