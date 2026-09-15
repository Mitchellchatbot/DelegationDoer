-- Every expense account itemized to the vendor/payment level, pulled from
-- QuickBooks (Profit & Loss Detail). One row per account/vendor/month. Powers
-- the "Every expense · by vendor" breakdown in the finance section (owner-only).
create table if not exists expense_line_items (
  id text primary key,
  account text not null,
  vendor text not null,
  month text not null,
  amount numeric not null default 0,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
