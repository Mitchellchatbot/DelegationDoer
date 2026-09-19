-- Monthly P&L history (Nov '25 – Aug '26) so the Learnings & Risks analysis has
-- a real trend. Normalized profit strips out taxes and one-off write-offs (the
-- Feb commission) which Mitchell flags as tax-only, not operating.
-- `taxes` + `writeoffs` are the amounts to add back to `net` for normalized net.
create table if not exists pnl_monthly (
  period text primary key,          -- 'YYYY-MM'
  label text not null,              -- "Aug '26"
  income numeric not null default 0,
  expenses numeric not null default 0,
  net numeric not null default 0,
  taxes numeric not null default 0,       -- add back for normalized net
  writeoffs numeric not null default 0,   -- one-off tax write-offs (e.g. Feb $20K commission)
  software numeric not null default 0,
  contractors numeric not null default 0,
  advertising numeric not null default 0,
  updated_at timestamptz not null default now()
);

insert into pnl_monthly (period, label, income, expenses, net, taxes, writeoffs, software, contractors, advertising) values
  ('2025-11', 'Nov ''25',  94329.42, 63977.94, 30416.48,     0,     0,  6942.22, 31174.00,  2048.84),
  ('2025-12', 'Dec ''25', 103281.56, 66265.23, 37016.33,     0,     0,  6561.85, 38392.00,  1430.26),
  ('2026-01', 'Jan ''26', 104216.33, 57565.52, 46679.97,     0,     0,  8079.38, 30136.41,  1922.88),
  ('2026-02', 'Feb ''26',  97964.70, 97822.50,   244.96, 25000, 20010,  7593.44, 28763.00,  2786.04),
  ('2026-03', 'Mar ''26', 105933.23, 74400.78, 31532.45, 10421,     0,  7398.95, 36885.30,   797.29),
  ('2026-04', 'Apr ''26', 100673.15, 65072.62, 35600.53,     0,     0,  8107.80, 36414.74,  1393.29),
  ('2026-05', 'May ''26',  95450.93, 95041.01,   502.20,     0,     0,  7164.96, 30130.62, 40677.22),
  ('2026-06', 'Jun ''26', 101778.50, 71461.37, 30395.09,     0,     0,  8601.40, 36565.18,  5838.41),
  ('2026-07', 'Jul ''26', 100538.01, 72318.83, 28309.41,     0,     0, 10761.44, 33382.78,  5362.85),
  ('2026-08', 'Aug ''26', 110665.83, 82515.65, 28246.14,     0,     0, 13192.81, 35942.00,  6613.83)
on conflict (period) do nothing;

notify pgrst, 'reload schema';
