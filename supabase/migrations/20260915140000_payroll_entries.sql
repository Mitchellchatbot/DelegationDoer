-- Payroll / contractors, by person — the Contractor Payments + payroll line
-- itemized, seeded from the People report and editable in the finance section.
-- Owner-only via app gates on /api/finance/payroll and the /finance page.
create table if not exists payroll_entries (
  id text primary key,
  name text not null,
  role text,
  status text not null default 'active', -- active | inactive | onboarding | invited
  scale text not null default 'monthly', -- monthly | annual
  rate numeric not null default 0,
  note text,
  rank int,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
