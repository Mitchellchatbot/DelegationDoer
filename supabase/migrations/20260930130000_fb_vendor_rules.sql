-- Vendors that are ALWAYS Facebook (owner-only). A persistent rule: any
-- expense_line_items row for this vendor counts as a Facebook expense, every
-- month, even inside a mixed account. Keyed by vendor name.
create table if not exists fb_vendor_rules (
  vendor text primary key,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
