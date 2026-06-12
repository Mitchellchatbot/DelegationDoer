-- Give inbox spaces an explicit display order. Until now the sidebar ordered
-- spaces purely by created_at (oldest first), so "Boss's Mail" sat below the
-- older Tech Hub / Website Team / SEO Team spaces. A not-null integer `position`
-- (default 0) lets us pin a space to the top without disturbing the rest — they
-- keep their created_at order within the same position bucket.
alter table public.inbox_spaces
  add column if not exists position integer not null default 0;

-- Pin "Boss's mail" above every other space. Match the name with a forgiving
-- ILIKE ('boss%mail%') rather than an exact/normalized string: the leader typed
-- it as "Boss's mail", and the possessive apostrophe-s makes exact matches
-- error-prone. Default position is 0, so -1 floats it to the top while every
-- other space keeps its created_at order among themselves.
update public.inbox_spaces
   set position = -1
 where name ilike 'boss%mail%';
