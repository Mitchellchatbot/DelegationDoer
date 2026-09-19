-- Facebook side of the business, month by month, as the Finance app reports it
-- (the accurate source Mitchell trusts). The /finance breakdown uses these as
-- the Facebook numbers and makes SEO the P&L remainder, so the two sides sum to
-- the P&L net. Owner enters/updates these from the Finance app dashboard.
create table if not exists facebook_monthly (
  period text primary key,      -- 'YYYY-MM'
  revenue numeric not null default 0,
  expenses numeric not null default 0,
  net_profit numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- August 2026, from the Finance app dashboard.
insert into facebook_monthly (period, revenue, expenses, net_profit)
values ('2026-08', 22335, 8720, 13615)
on conflict (period) do nothing;

notify pgrst, 'reload schema';
