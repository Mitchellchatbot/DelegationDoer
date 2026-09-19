-- The real commission EARNED in a month (accrual), separate from what the P&L
-- booked that month (cash — Aug's commission is paid in Sept). Lets the Facebook
-- card show "true month" profit (commission earned) alongside the books profit
-- (commission as the P&L booked it, which reconciles to the P&L).
alter table facebook_monthly add column if not exists commission numeric not null default 0;

-- August 2026: the real commission earned that month (~$5,500, paid in Sept).
update facebook_monthly set commission = 5500 where period = '2026-08' and commission = 0;

notify pgrst, 'reload schema';
