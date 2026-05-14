-- Clients can run multiple websites (e.g. the Villa cohort has
-- Treatment / Behavioral / Healing / NJ Drug Resource / Northridge
-- all under one umbrella). Add a `websites` array alongside the
-- primary `website` column so the detail page can list them all.
-- The primary `website` stays as the canonical "main site" for
-- compatibility with existing helpers (clients-data, ai-tools, the
-- task→client domain match for inbox surfacing).
alter table public.clients
  add column if not exists websites text[] not null default '{}';

-- Backfill: every existing row gets its `website` lifted into the
-- array so UIs that iterate over `websites` can ignore `website`
-- entirely.
update public.clients
   set websites = ARRAY[website]
 where website is not null
   and website <> ''
   and (websites is null or websites = '{}');
