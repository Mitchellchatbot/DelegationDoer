-- Service lines on clients — splits Facebook clients from the SEO/Website book.
--
-- One table, tagged: a client carries every line it buys. 'seo_web' is the
-- original business (every existing row), 'facebook' is the Facebook ads
-- team. A client on both shows under both tabs on /clients. The SEO-only
-- surfaces (health dashboard, SEO client split, bulk SEO update) skip clients
-- that don't carry 'seo_web'.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

alter table public.clients
  add column if not exists service_lines text[] not null default array['seo_web']::text[];

alter table public.clients drop constraint if exists clients_service_lines_check;
alter table public.clients
  add constraint clients_service_lines_check
  check (cardinality(service_lines) > 0 and service_lines <@ array['seo_web', 'facebook']::text[]);

create index if not exists clients_service_lines_idx on public.clients using gin (service_lines);
