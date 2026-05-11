-- "Moments" — a shared spatial grid of images of the team's day.
-- Anyone can post, anyone can browse; deletion is self-only (or CEO).
create table if not exists moments (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  image_url text not null,
  caption text,
  created_at timestamptz not null default now()
);

create index if not exists moments_created_idx on moments(created_at desc);
create index if not exists moments_user_idx on moments(user_id, created_at desc);
