-- The original recent_inbound_missive_messages function filtered by
-- `direction = 'in'`, but missive's imap ingest writes 'inbound'
-- (full word) per missiveclone/backend/src/email/imap.js. The cron
-- consequently saw 0 messages even when the workspace had thousands
-- of inbound emails. Re-create the function with the correct value.
--
-- CREATE OR REPLACE keeps the same signature so existing callers
-- need no code changes.

create or replace function public.recent_inbound_missive_messages(
  since_ms bigint,
  msg_limit int default 5000
)
returns table (
  id text,
  subject text,
  body_text text,
  from_addr text,
  sent_at bigint
)
language sql
security definer
stable
set search_path = missive, public
as $$
  select id, subject, body_text, from_addr, sent_at
  from missive.messages
  where sent_at >= since_ms
    and direction = 'inbound'
  order by sent_at desc
  limit msg_limit;
$$;

revoke all on function public.recent_inbound_missive_messages(bigint, int) from public;
grant execute on function public.recent_inbound_missive_messages(bigint, int) to service_role;
