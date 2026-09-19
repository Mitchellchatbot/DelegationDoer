-- Business-segment labels for the finance breakdown (Facebook vs SEO/website).
-- Revenue and expenses both live in ONE P&L / ONE Stripe, so the breakdown
-- splits that single P&L by labelling its inputs:
--   - mrr_entries.segment    → which revenue clients are Facebook (drives the
--                              revenue split ratio, applied to P&L income)
--   - payroll_entries.segment → which contractors are Facebook (splits the one
--                              "Contractor Payments" P&L line by their share)
--   - expense_segments        → which P&L expense LINES are Facebook (already exists)
alter table mrr_entries add column if not exists segment text not null default 'seo' check (segment in ('seo', 'facebook'));
alter table payroll_entries add column if not exists segment text not null default 'seo' check (segment in ('seo', 'facebook'));

-- Conservative pre-labels: only the obviously-Facebook rows start as Facebook;
-- everything else stays SEO for Mitchell to adjust.
update mrr_entries set segment = 'facebook' where segment = 'seo' and (company ilike '%facebook%' or company ilike '%meta%');
update payroll_entries set segment = 'facebook' where segment = 'seo' and role ilike '%facebook%';
insert into expense_segments (account, segment) values ('Facebook', 'facebook') on conflict (account) do nothing;

notify pgrst, 'reload schema';
