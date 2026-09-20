-- Distinguish payment source (Deel vs bank) so a Deel reload doesn't wipe
-- bank-paid contractors, and record Sam's Novo (bank) payments = the outside-Deel
-- gap vs the P&L Contractor Payments line, positive months only.
alter table deel_payments add column if not exists source text not null default 'deel';
delete from deel_payments where source = 'novo';
insert into deel_payments (period, contractor, amount, is_fee, source) values
  ('2026-02','Sam (Novo)',342,false,'novo'),
  ('2026-03','Sam (Novo)',8931,false,'novo'),
  ('2026-04','Sam (Novo)',6563,false,'novo'),
  ('2026-06','Sam (Novo)',9321,false,'novo'),
  ('2026-07','Sam (Novo)',852,false,'novo'),
  ('2026-08','Sam (Novo)',5716,false,'novo');
notify pgrst, 'reload schema';
