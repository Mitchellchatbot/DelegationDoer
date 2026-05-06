-- Demo: one ticket assigned to Henry (CEO) without an ack row, so the widget
-- alert fires the moment he opens the desktop bubble. Safe to delete later.

insert into public.tickets
  (id, title, description, status, priority, estimated_hours, actual_hours, tags,
   department_id, assignee_id, creator_id, project_id, due_date, inactive_flag,
   last_activity_at, created_at, blocks_ticket_ids)
values
  ('t_demo_ack',
   'Approve Q3 ad budget',
   'Sara needs sign-off on the Spring promo creatives budget before Friday.',
   'pending', 'high', 1, 0, array['client-request'],
   'dep_mkt', 'u_1', 'u_4', 'p_3',
   now() + interval '1 day', false,
   now(), now(), '{}')
on conflict (id) do nothing;
