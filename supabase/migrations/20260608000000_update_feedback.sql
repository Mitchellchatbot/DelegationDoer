-- Team recognition / feedback on "updates" (EODs today; designed to extend
-- to project updates, completed tasks, etc. via the polymorphic
-- target_type + target_id pair so we don't add a new table per surface).
--
-- Two surfaces:
--
--   update_reactions  — quick emoji a teammate slaps on someone's update.
--                       Unique on (target, user, emoji) so the same
--                       person can react with 👏 AND 🔥 but not double-
--                       👏 the same item.
--
--   update_replies    — threaded comments / encouragement on an update.
--                       Can optionally be flagged is_kudos=true (with an
--                       attached emoji) — that's how the UI lights up
--                       "Great work!" preset replies as recognition,
--                       distinct from a generic comment.
--
-- Both tables intentionally keep target_type as a free-form text column
-- (rather than an enum or a separate FK per type) so adding "task",
-- "project_update", etc. later is zero-schema-change.

create table if not exists update_reactions (
  id text primary key,
  target_type text not null,
  target_id text not null,
  user_id text not null references public.users(id) on delete cascade,
  emoji text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  unique (target_type, target_id, user_id, emoji)
);

create index if not exists update_reactions_target_idx
  on update_reactions(target_type, target_id);

create index if not exists update_reactions_user_idx
  on update_reactions(user_id, created_at desc);

create table if not exists update_replies (
  id text primary key,
  target_type text not null,
  target_id text not null,
  user_id text not null references public.users(id) on delete cascade,
  body text not null check (length(body) between 1 and 2000),
  -- Recognition flair: if true, the UI shows this reply with a kudos
  -- ribbon + the chosen emoji. Lets "Great job!" presets stand out.
  is_kudos boolean not null default false,
  kudos_emoji text,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create index if not exists update_replies_target_idx
  on update_replies(target_type, target_id, created_at);

create index if not exists update_replies_user_idx
  on update_replies(user_id, created_at desc);
