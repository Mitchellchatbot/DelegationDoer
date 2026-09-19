-- Facebook assignment system: which P&L lines and which software vendors are
-- Facebook. Facebook expenses = the assigned P&L leaf lines + assigned software
-- vendors; Facebook revenue comes from facebook_monthly (the Finance app). SEO
-- is the P&L remainder, owner salary excluded, reconciling to the P&L.

-- Software vendors get their own Facebook/SEO flag (splits the Software lump).
alter table software_subscriptions add column if not exists segment text not null default 'seo' check (segment in ('seo', 'facebook'));
update software_subscriptions set segment = 'facebook' where vendor ilike 'Tracking Academy';

-- P&L leaf lines that are Facebook (the fixed list Mitchell confirmed).
insert into expense_segments (account, segment) values
  ('Commissions & Fees', 'facebook'),
  ('Facebook', 'facebook'),
  ('Ads with Finnesse', 'facebook')
on conflict (account) do update set segment = 'facebook';

-- Contractors are NOT part of the Facebook split (Altamash reverted to SEO).
update payroll_entries set segment = 'seo' where segment = 'facebook';

notify pgrst, 'reload schema';
