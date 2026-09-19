-- Business-segment labels so the finance section can split into two sides:
-- Facebook (Meta, 50/50 with a partner) vs SEO & website (everything else).
--
-- expense_segments: which P&L expense LINES belong to Facebook. Keyed by the
-- expense-line account name (same key space as expense_estimates). Anything
-- without a row defaults to 'seo', so today the SEO side = the whole P&L until
-- Mitchell tags lines as Facebook.
create table if not exists expense_segments (
  account text primary key,
  segment text not null default 'seo' check (segment in ('seo', 'facebook')),
  updated_at timestamptz not null default now()
);

-- stripe_oneoff_segments: which one-time Stripe payments are Facebook. Keyed by
-- the Stripe charge id. Untagged one-offs count as SEO/website (the default);
-- tagging one Facebook reclassifies it from the SEO side to the Facebook side.
create table if not exists stripe_oneoff_segments (
  payment_id text primary key,
  segment text not null default 'seo' check (segment in ('seo', 'facebook')),
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
