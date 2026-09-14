-- Cached, dashboard-ready parse of each P&L (periods, summary lines, expense
-- breakdown). Populated on upload by src/lib/pnl-parse.ts. Applied live.
alter table public.finance_documents add column if not exists parsed jsonb;
