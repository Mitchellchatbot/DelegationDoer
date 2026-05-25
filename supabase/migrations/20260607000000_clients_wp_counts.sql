-- WordPress blog-count panel for the SEO team on each client's detail page.
-- We store an override URL (clients with mismatched primary website vs WP
-- site), the last counted value, when it was last counted, and the most
-- recent error so the UI can surface "couldn't reach WordPress" without
-- waiting on a live request. Service pages are deliberately omitted from
-- v1 — we'll add columns once Hamza confirms how each client structures
-- them in WP.

alter table clients
  add column if not exists wp_url                 text,
  add column if not exists wp_blog_posts_count    integer,
  add column if not exists wp_counts_updated_at   timestamptz,
  add column if not exists wp_last_error          text;
