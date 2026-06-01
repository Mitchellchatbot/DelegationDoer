-- Per-client profile picture URL.
--
-- Stored as a plain URL string pointing into Supabase Storage's
-- ticket-attachments bucket (same one /api/upload writes to). Leaders
-- set this per client so the grid / detail page shows a recognizable
-- logo or photo instead of the generic briefcase icon. Null = fall back
-- to the briefcase.
alter table public.clients
  add column if not exists icon_url text;
