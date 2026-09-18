-- Mitchell's next-month estimate for each expense line (a forward budget). One
-- row per expense-line account name; the amount is what he expects to spend
-- next month. Editable inline in the expense breakdown; the finance brain reads
-- these for "what's my burn next month".
create table if not exists expense_estimates (
  account text primary key,
  amount numeric not null default 0,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
