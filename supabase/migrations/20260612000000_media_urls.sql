-- Attach media (images, audio, etc.) to tasks and email drafts.
--
-- Shape per entry:
--   { url: string, name?: string, contentType?: string, size?: number }
-- URL is a Supabase Storage public URL from the existing /api/upload route
-- (bucket = ticket-attachments). Both columns default to '[]' so existing
-- rows read as "no media."

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS media_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE email_drafts
  ADD COLUMN IF NOT EXISTS media_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
