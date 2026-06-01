-- Per-client SEO brief from leadership.
--
-- Leaders / admins write a free-form brief here listing the target
-- services, talking points, and "what we want the SEO team focused on
-- this cycle". Shows on the client detail page for anyone who can view
-- the client; collected onto a dedicated card on /home for users in
-- dep_seo so the SEO team sees an at-a-glance list of every brief
-- their leader has set.
--
-- Free text only — no structured services array (yet). Leaders can
-- format the brief however they want (markdown-ish lists, bullets,
-- etc.); we render it preformatted.
alter table public.clients
  add column if not exists seo_brief text;
alter table public.clients
  add column if not exists seo_brief_at timestamptz;
alter table public.clients
  add column if not exists seo_brief_by text references public.users(id) on delete set null;
