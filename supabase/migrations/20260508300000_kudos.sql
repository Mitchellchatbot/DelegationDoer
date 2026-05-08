-- Kudos: short celebratory messages teammates send each other. They land
-- on the recipient's desktop widget as a celebration banner until they
-- acknowledge it. Acknowledgement is per-kudos (not per-batch) so the UI
-- can dismiss them one at a time.
create table if not exists kudos (
  id text primary key,
  from_user_id text references users(id) on delete set null,
  to_user_id   text not null references users(id) on delete cascade,
  message text not null check (length(message) between 1 and 280),
  emoji text default '👏',
  created_at timestamptz not null default now(),
  -- Null = unread on the widget. The widget POSTs to flip this to now().
  acknowledged_at timestamptz
);

create index if not exists kudos_to_unread_idx on kudos(to_user_id, acknowledged_at);
create index if not exists kudos_created_idx on kudos(created_at desc);
