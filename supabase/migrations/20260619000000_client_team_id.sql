-- Per-client team assignment. Five buckets across two departments:
--   - team_web        Websites team
--   - team_seo_sam    SEO · Sam team
--   - team_seo_bismah SEO · Bismah team
--   - team_seo_samir  SEO · Samir team
--   - team_seo_saif   SEO · Saif team
--
-- Stored as a free-text id (not a foreign key) so we can rename or
-- add buckets without a migration. Application code enforces the
-- allowed set; nulls are allowed and mean "unassigned".

alter table public.clients
  add column if not exists team_id text;

create index if not exists clients_team_id_idx
  on public.clients (team_id)
  where team_id is not null;
