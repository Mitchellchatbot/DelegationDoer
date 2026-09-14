-- Owner-only financials (P&L). Metadata table + a PRIVATE storage bucket.
-- The page (/finance) and the API routes are gated to the owner
-- (isOwner / mitchell@scaledai.org); files are reached only via short-lived
-- server-signed URLs, never a public URL. Both objects were applied to the
-- live DB via `supabase db query` / the storage API; this records them.
create table if not exists public.finance_documents (
  id           text primary key,
  label        text,
  filename     text not null,
  storage_key  text not null,
  content_type text,
  size_bytes   integer,
  uploaded_at  timestamptz not null default now()
);

insert into storage.buckets (id, name, public)
  values ('finance', 'finance', false)
  on conflict (id) do nothing;
