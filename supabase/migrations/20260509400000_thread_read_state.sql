-- Per-user read state for Missive threads. The clone API doesn't track
-- read state itself, so we shadow it here. One row per (user, thread)
-- that the user has marked read at least once; absent row = unread.
--
-- Updated whenever a user opens a thread (auto-marks read) or hits a
-- bulk-mark-read action.

create table if not exists thread_read_state (
  user_id text not null references users(id) on delete cascade,
  thread_id text not null,            -- Missive thread id (no FK; the
                                      -- clone is the source of truth for
                                      -- the thread itself).
  account_id text not null,           -- Snapshot of which inbox the thread
                                      -- lives in — lets us answer "how many
                                      -- unread in inbox X" without joining
                                      -- back to the clone.
  last_read_at timestamptz not null default now(),
  -- Highest message timestamp at read time. If a newer message arrives
  -- after this, the thread re-surfaces as unread. (`null` = read at any
  -- state; useful for a "mark all read" button that doesn't know the
  -- latest message timestamp.)
  read_through_at timestamptz,
  primary key (user_id, thread_id)
);

create index if not exists thread_read_state_user_idx
  on thread_read_state(user_id, account_id, last_read_at desc);
