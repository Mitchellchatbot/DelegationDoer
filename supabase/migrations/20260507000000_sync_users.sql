-- Sync users table to match the (now-canonical) values previously held in
-- src/lib/mock-data.ts. After this migration the app reads users from
-- Supabase directly and mock-data.ts is no longer the source of truth on the
-- server side.
--
--   * u_1   -> Shaheer Khosa  (real Slack workspace email — used to receive
--                              assignment DMs while testing)
--   * u_10  -> Mitchell Price (new — needs to exist in DB so the ticket
--                              creation API can look up his email)

update public.users
   set name  = 'Shaheer Khosa',
       email = 'shaheerkhosa6@gmail.com'
 where id = 'u_1';

insert into public.users (id, name, email, role, daily_capacity, throughput, skills) values
  ('u_10', 'Mitchell Price', 'mitchell@scaledai.org', 'worker', 8,
    '{"features_per_week":3}'::jsonb,
    array['typescript','react'])
on conflict (id) do update
  set name           = excluded.name,
      email          = excluded.email,
      role           = excluded.role,
      daily_capacity = excluded.daily_capacity,
      throughput     = excluded.throughput,
      skills         = excluded.skills;

insert into public.department_members (user_id, department_id) values
  ('u_10', 'dep_software')
on conflict do nothing;
