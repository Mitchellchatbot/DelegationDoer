-- Standard Operating Procedures + RAG support.
--   * sops: one row per uploaded document. Original file kept in
--     Supabase Storage; we keep the URL + basic metadata here.
--   * sop_chunks: ~500-token slices of the document, each with its
--     own embedding so the Ask AI tool can vector-search across the
--     whole library. Image-derived chunks carry the source image URL
--     so the chatbot can cite the picture, not just its caption.
--
-- pgvector ships with Supabase but isn't enabled by default per
-- project — the CREATE EXTENSION below is a no-op once it's on.

create extension if not exists vector;

create table if not exists sops (
  id text primary key,
  title text not null,
  source_filename text not null,
  mime_type text not null,
  file_url text not null,
  byte_size integer not null default 0,
  created_by text not null references users(id) on delete set null,
  ingest_warnings text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sops_created_at on sops(created_at desc);

create table if not exists sop_chunks (
  id text primary key,
  sop_id text not null references sops(id) on delete cascade,
  position integer not null,
  content text not null,
  -- When the chunk came from a captioned image, keep a pointer so
  -- chatbot answers can show the original picture, not just text.
  image_url text,
  embedding vector(1536) not null,
  token_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_sop_chunks_sop_pos on sop_chunks(sop_id, position);

-- HNSW index for cosine-similarity vector search. m=16 / ef_construction=64
-- are pgvector's recommended defaults for ≤1M rows, which we'll be well
-- under for the foreseeable future.
create index if not exists idx_sop_chunks_embedding
  on sop_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- RPC for the chatbot's search_sops tool. Takes the user's embedded
-- question and returns the top matching chunks joined with their SOP's
-- title and source file, ordered by cosine distance. Exposed as an RPC
-- because supabase-js can't bind native vector params on raw SQL.
create or replace function search_sop_chunks(
  query_embedding vector(1536),
  match_limit int default 5
)
returns table (
  chunk_id text,
  sop_id text,
  title text,
  source_filename text,
  -- "position" is a SQL-standard reserved keyword (the POSITION(substr
  -- IN str) function), so RETURNS TABLE rejects it as a column name
  -- even though CREATE TABLE accepts it. Rename here to chunk_position.
  chunk_position int,
  content text,
  image_url text,
  file_url text,
  distance float
)
language sql
stable
as $$
  select c.id, c.sop_id, s.title, s.source_filename, c.position,
         c.content, c.image_url, s.file_url,
         (c.embedding <=> query_embedding) as distance
  from sop_chunks c
  join sops s on s.id = c.sop_id
  order by c.embedding <=> query_embedding
  limit match_limit;
$$;
