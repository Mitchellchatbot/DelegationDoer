-- Per-user FORCE-ON for the SOD/EOD ritual.
--
-- Leaders + stealth admins (is_admin = true) are exempt from the daily
-- SOD/EOD ritual by role — the SOD modal gate (/api/sod/today) and the
-- /home Day Bookends card both skip them, same as ClockGate. This flag
-- opts a specific privileged account BACK IN: when true it overrides the
-- role exemption (and a false daily_prompts_enabled), so the user runs
-- SOD/EOD like a normal worker.
--
-- Default false matches existing behavior (no one is forced). Mirrors the
-- per-user daily_prompts_enabled toggle added in 20260623000000.
alter table public.users
  add column if not exists daily_prompts_required boolean not null default false;

-- Opt exactly two accounts back into SOD/EOD. Both are stealth admins
-- (is_admin = true) so the role exemption would otherwise suppress the
-- ritual for them:
--   - henry@scaledai.org      (Henry Chen, ceo + is_admin)
--   - shaheerkhosa6@gmail.com (Shaheer Khosa, worker + is_admin)
-- Also (re)assert daily_prompts_enabled = true so neither path can leave
-- them disabled. Matched by EXACT email. RAISE NOTICE confirms the count.
do $$
declare
  affected int;
begin
  update public.users
     set daily_prompts_required = true,
         daily_prompts_enabled  = true
   where lower(email) in ('henry@scaledai.org', 'shaheerkhosa6@gmail.com');

  get diagnostics affected = row_count;

  if affected = 0 then
    raise notice 'No matching user found — please verify the two emails.';
  elsif affected = 2 then
    raise notice 'daily_prompts_required set for Henry + Shaheer (2 rows).';
  else
    raise notice 'daily_prompts_required set on % row(s) — expected 2; please verify.', affected;
  end if;
end $$;
