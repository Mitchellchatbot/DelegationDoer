-- Tickets can be tied to a client (e.g. "Acme Insurance") and/or a website
-- (e.g. "acme-insurance.com"). Both nullable — internal-tools work has neither.

alter table public.tickets
  add column if not exists client_name text,
  add column if not exists website text;

create index if not exists tickets_client_name_idx on public.tickets (client_name);
create index if not exists tickets_website_idx on public.tickets (website);

-- Backfill the seed rows so filters have something interesting to filter by.
update public.tickets set client_name = 'Acme Insurance', website = 'acme-insurance.com'
  where id in ('t_1', 't_2', 't_5', 't_6', 't_10');
update public.tickets set client_name = 'Lawsmith Group', website = 'lawsmith.com'
  where id in ('t_3', 't_4', 't_9', 't_12');
update public.tickets set client_name = 'Spring Lifecycle Co', website = 'spring-lifecycle.com'
  where id in ('t_7', 't_8');
-- t_11 and t_13 are internal — leave client/website null.
