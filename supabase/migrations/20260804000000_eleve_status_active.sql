-- Eleve Wellness was seeded status='pending' in 20260518000000_clients_table.sql
-- and has been stranded there ever since: no write path in the app ever sets
-- clients.status (the create route omits it, the PATCH route has no status
-- branch), so nothing could correct it. Meanwhile the team logs real EOD work
-- against it, and every "active clients" surface -- EOD digest recommendations,
-- the home widgets, the icon backfill -- filters on status = 'active', silently
-- dropping it. It is an active client; make the record say so.
-- Idempotent; safe to re-run.
update public.clients
   set status = 'active',
       updated_at = now()
 where id = 'cl_eleve'
   and status <> 'active';
