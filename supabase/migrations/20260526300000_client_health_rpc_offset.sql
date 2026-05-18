-- Supabase's PostgREST caps response rows at 1000 by default, even
-- when the underlying SQL has a higher LIMIT. The client-health cron
-- needed more (workspaces have weeks of mail = tens of thousands of
-- rows) but `msg_limit: 5000` was being silently truncated to 1000.
--
-- Solution: add an offset parameter to the RPC so the cron can
-- page through 1000-row batches as many times as needed.

create or replace function public.recent_inbound_missive_messages(
  since_ms bigint,
  msg_limit int default 1000,
  offset_rows int default 0
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
  limit msg_limit
  offset offset_rows;
$$;

revoke all on function public.recent_inbound_missive_messages(bigint, int, int) from public;
grant execute on function public.recent_inbound_missive_messages(bigint, int, int) to service_role;

-- Drop the older 2-param overload so supabase.rpc() unambiguously
-- resolves to the new signature.
drop function if exists public.recent_inbound_missive_messages(bigint, int);

notify pgrst, 'reload schema';
