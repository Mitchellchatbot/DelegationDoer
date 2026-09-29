-- What each contractor is for. Mitchell tags every contractor with a department
-- so contractor spend can be grouped/sorted and eventually split FB vs SEO.
-- Keyed by contractor name (matches deel_payments.contractor).
create table if not exists contractor_departments (
  contractor text primary key,
  department text not null default 'Unassigned',
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
