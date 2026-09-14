-- Vendor-level breakdown of the Software/Subscriptions expense line, seeded
-- from the QuickBooks software transaction report. One row per vendor per
-- month so the dashboard can show any number of months as columns.
create table if not exists software_subscriptions (
  id text primary key,
  vendor text not null,
  month text not null,
  amount numeric not null default 0,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
