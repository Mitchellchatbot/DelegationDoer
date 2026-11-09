-- Executive AI Assistant, P5a: switch DD text triage OFF for the owner and remove every stored
-- summary at once. For an outage of the Settings page (the page is the normal switch, and
-- there is no enable script: switch it back on from Settings).
--
-- HAND-RUN in the Supabase SQL editor, which runs the whole file as one transaction. Never run
-- by the app or by Claude. Safe to re-run.
--
-- For the owner's principal (mitchell@scaledai.org) it:
--   1. sets exec_settings.ddtext_enabled = false (the triage stops at its next run);
--   2. deletes every exec_ddtext_items row (the signals and their AI summaries cascade);
--   3. deletes every DD text attention row (exec_attention_items, source dd, kinds ddtext_blocker,
--      ddtext_waiting, ddtext_decision, ddtext_mention), in every status, with the AI-assessed
--      fact each one carries;
-- then shows one grid: EXPECT ddtext_enabled = false and items, signals and ddtext attention
-- rows all 0. Other attention rows are left alone. The next triage run finds nothing to delete.
-- The triage cursor is kept, so switching it on again resumes from it (never further back than
-- min(14, retention_days_ddtext) days).

set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_attribute
                  where attrelid = to_regclass('public.exec_settings') and attname = 'ddtext_enabled' and not attisdropped)
     or to_regclass('public.exec_ddtext_items') is null or to_regclass('public.exec_ddtext_signals') is null then
    raise exception 'disable aborted, nothing changed: the P5a migration is missing (20261106100000_exec_dashboard.sql), so DD text triage cannot be on';
  end if;
end $$;

update public.exec_settings s
   set ddtext_enabled = false, updated_at = now()
  from public.exec_principals p
  join public.users u on u.id = p.user_id
 where s.principal_id = p.id
   and lower(trim(u.email)) = 'mitchell@scaledai.org';

delete from public.exec_ddtext_items i
 using public.exec_principals p
  join public.users u on u.id = p.user_id
 where i.principal_id = p.id
   and lower(trim(u.email)) = 'mitchell@scaledai.org';

delete from public.exec_attention_items a
 using public.exec_principals p
  join public.users u on u.id = p.user_id
 where a.principal_id = p.id
   and lower(trim(u.email)) = 'mitchell@scaledai.org'
   and a.source = 'dd'
   and a.kind in ('ddtext_blocker', 'ddtext_waiting', 'ddtext_decision', 'ddtext_mention');

select p.id as principal_id,
       s.ddtext_enabled,
       (select count(*)::int from public.exec_ddtext_items i where i.principal_id = p.id) as items,
       (select count(*)::int from public.exec_ddtext_signals g where g.principal_id = p.id) as signals,
       (select count(*)::int from public.exec_attention_items a
         where a.principal_id = p.id and a.source = 'dd'
           and a.kind in ('ddtext_blocker', 'ddtext_waiting', 'ddtext_decision', 'ddtext_mention')) as ddtext_attention_rows
  from public.exec_principals p
  join public.users u on u.id = p.user_id
  left join public.exec_settings s on s.principal_id = p.id
 where lower(trim(u.email)) = 'mitchell@scaledai.org';
