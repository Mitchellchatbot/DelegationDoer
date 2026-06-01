-- One-shot: flip daily_prompts_enabled = false on Mitchell's user row.
--
-- Mitchell doesn't run the SOD/EOD ritual himself, so the bookend card
-- on /home and the widget's EOD nudge shouldn't pop up for him. Same
-- per-user opt-out the column was added for in 20260623000000.
--
-- Match is permissive (email pattern OR name ILIKE), restricted to
-- scaledai.org so we can't catch an unrelated Mitchell. RAISE NOTICE
-- confirms which row(s) flipped.

do $$
declare
  affected int;
  matched_email text;
begin
  update public.users
     set daily_prompts_enabled = false
   where lower(email) like 'mitch%@scaledai.org'
      or (lower(email) like '%@scaledai.org' and name ilike '%mitchell%')
      or (lower(email) like '%@scaledai.org' and name ilike '%mitch %')
  returning email into matched_email;

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify Mitchell''s email/name.';
  elsif affected = 1 then
    raise notice 'daily_prompts_enabled set to false on % (1 row).', matched_email;
  else
    raise notice 'daily_prompts_enabled flipped on % rows — please verify only Mitchell was intended.', affected;
  end if;
end $$;
