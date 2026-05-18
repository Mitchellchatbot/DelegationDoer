-- The client-health cron needs to read recent inbound emails from the
-- missiveclone schema. supabase-js can't `.schema('missive')` because
-- PostgREST only exposes the public schema by default, and adding
-- `missive` to the exposed list would let every authenticated user
-- query every missive table — including raw bodies and credentials.
--
-- Instead: expose a SECURITY DEFINER function in `public` that does
-- the exact read we need. The function runs with the privileges of
-- its owner (the supabase admin), so it can read `missive.messages`
-- freely, but the caller can only see what the function chooses to
-- return. The cron calls this via supabase.rpc().

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
    and direction = 'in'
  order by sent_at desc
  limit msg_limit;
$$;

-- The function is callable by any authenticated role (the cron uses
-- the service role, so this matters for whether other surfaces could
-- accidentally use it). Lock down execute to service_role only.
revoke all on function public.recent_inbound_missive_messages(bigint, int) from public;
grant execute on function public.recent_inbound_missive_messages(bigint, int) to service_role;
