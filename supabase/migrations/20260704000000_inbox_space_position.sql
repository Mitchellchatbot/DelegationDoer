-- Give inbox spaces an explicit display order. Until now the sidebar ordered
-- spaces purely by created_at (oldest first), so "Boss's Mail" sat below the
-- older Tech Hub / Website Team / SEO Team spaces. A not-null integer `position`
-- (default 0) lets us pin a space to the top without disturbing the rest — they
-- keep their created_at order within the same position bucket.
alter table public.inbox_spaces
  add column if not exists position integer not null default 0;

-- Pin "Boss's Mail" above every other space. The exact name was typed by a
-- leader in the UI, so match on a case/punctuation/whitespace-insensitive
-- normalization — "Boss's Mail", "BOSS'S MAIL", a curly apostrophe, etc. all
-- collapse to "bossmail". Default position is 0, so -1 floats it to the top
-- while every other space keeps its created_at order among themselves.
update public.inbox_spaces
   set position = -1
 where regexp_replace(lower(name), '[^a-z0-9]+', '', 'g') = 'bossmail';
