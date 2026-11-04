-- Executive AI Assistant — P2a foundation.
--
-- Tables every later phase builds on, plus the durable job queue:
--
--   exec_principals   the executives the assistant works for (Mitchell today).
--                     mail_account_ids pins mail access to the principal's own
--                     mailbox (seeded in P3); slack ids are bound at OAuth (P6).
--   exec_settings     per-principal settings (brief time/zone, policies,
--                     retention, daily AI cost cap).
--   exec_jobs         durable background work: lanes, leases, fencing, dedupe.
--   exec_audit_log    every side effect the assistant takes (no message bodies).
--   exec_access_log   every request to the assistant's pages/APIs/Slack.
--   exec_ai_usage     every model call: tokens, cost, latency.
--   exec_sync_state   incremental cursors per principal/source.
--
-- Security: all tables have RLS ON with NO policies and nothing granted to
-- anon/authenticated — the app reaches them only through the service role
-- (see 20261104000000_p0_lock_down_anon_access.sql). The job RPCs are
-- SECURITY INVOKER with a pinned search_path and EXECUTE for service_role only.
--
-- Nothing reads these tables until EXEC_ENABLED=true on the app, so applying
-- this early is harmless.
--
-- Idempotent. Apply MANUALLY in the Supabase SQL editor. Merging runs nothing.

set local lock_timeout = '5s';

-- Pre-flight: the owner's DD user must exist exactly once (it seeds the first
-- principal). Aborts before changing anything.
do $$
declare
  n int;
begin
  select count(*) into n from public.users where lower(trim(email)) = 'mitchell@scaledai.org';
  if n <> 1 then
    raise exception 'exec foundation aborted, nothing changed: expected exactly 1 users row for mitchell@scaledai.org, found %', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Principals and settings
-- ---------------------------------------------------------------------------

create table if not exists public.exec_principals (
  id               text primary key default ('ep_' || replace(gen_random_uuid()::text, '-', '')),
  user_id          text not null unique references public.users(id) on delete cascade,
  enabled          boolean not null default true,
  mail_account_ids text[] not null default '{}',
  slack_team_id    text,
  slack_user_id    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.exec_settings (
  principal_id           text primary key references public.exec_principals(id) on delete cascade,
  brief_enabled          boolean not null default false,
  brief_local_time       text not null default '08:00'
                           check (brief_local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  brief_timezone         text,
  supersede_legacy_brief boolean not null default false,
  checkins_enabled       boolean not null default true,
  -- Decision R in the plan: 'hidden' until the owner opts into 'dd_only'.
  restricted_policy      text not null default 'hidden'
                           check (restricted_policy in ('hidden', 'dd_only')),
  watch_mode             text not null default 'active_public'
                           check (watch_mode in ('active_public', 'member_only')),
  muted_channel_ids      text[] not null default '{}',
  retention_days_slack   int not null default 90 check (retention_days_slack between 1 and 3650),
  retention_days_email   int not null default 180 check (retention_days_email between 1 and 3650),
  retention_days_chat    int not null default 90 check (retention_days_chat between 1 and 3650),
  daily_cost_cap_usd     numeric(10, 2) not null default 15 check (daily_cost_cap_usd >= 0),
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Durable jobs
-- ---------------------------------------------------------------------------

create table if not exists public.exec_jobs (
  id           bigint generated always as identity primary key,
  kind         text not null,
  lane         text not null check (lane in ('interactive', 'bulk')),
  principal_id text references public.exec_principals(id) on delete cascade,
  -- References only (ids, event ids, cursors) — never message bodies.
  payload      jsonb not null default '{}'::jsonb,
  -- Unique: a duplicate enqueue (Slack retry, two schedulers) is a no-op.
  dedupe_key   text unique,
  status       text not null default 'queued'
                 check (status in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  attempts     int not null default 0,
  max_attempts int not null default 6 check (max_attempts between 1 and 20),
  run_after    timestamptz not null default now(),
  locked_by    text,
  locked_until timestamptz,
  heartbeat_at timestamptz,
  last_error   text,
  result       jsonb,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create index if not exists exec_jobs_claimable_idx on public.exec_jobs (lane, run_after, id) where status = 'queued';
create index if not exists exec_jobs_running_idx on public.exec_jobs (locked_until) where status = 'running';
create index if not exists exec_jobs_finished_idx on public.exec_jobs (finished_at)
  where status in ('succeeded', 'dead', 'cancelled');
create index if not exists exec_jobs_principal_idx on public.exec_jobs (principal_id, created_at desc);

-- Claim up to p_limit due jobs of one lane for p_worker, leasing them for
-- p_lease_seconds. FOR UPDATE SKIP LOCKED means concurrent claimers (two
-- Railway processes, an overlapping deploy) never get the same row.
--
-- p_worker is half of the fence (locked_by + attempts) that heartbeat and
-- finish check. A NULL one would lease jobs that no heartbeat or finish can
-- ever match (locked_by = NULL is never true): each would run, be reaped and
-- run again until its attempts ran out. A blank one (empty or all spaces)
-- does match, but it names no process, so a lease (and the reaper's
-- `lease expired (worker )` note) can't be traced to one. Both are refused.
-- The limit is capped at 100 and the lease at 1 hour (heartbeats keep long
-- jobs alive), so a runaway caller can't lease the whole queue to one process
-- or strand a crashed worker's jobs for days.
--
-- p_kinds is the job kinds the calling process has handlers for. While two
-- releases overlap in a deploy (or after a rollback), a process that predates
-- a kind must not claim it: it could only send it back to the queue, using up
-- an attempt. The app always passes its registered kinds. NULL (the default,
-- for hand use in the SQL editor) means any kind; an empty array claims nothing.
--
-- Dropped first so a re-run after an earlier 4-argument draft can't leave two
-- overloads (a 4-argument call would then be ambiguous).
drop function if exists public.exec_claim_jobs(text, text, int, int);
create or replace function public.exec_claim_jobs(
  p_worker text,
  p_lane text,
  p_limit int,
  p_lease_seconds int,
  p_kinds text[] default null
)
returns setof public.exec_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'exec_claim_jobs: p_worker is required';
  end if;

  return query
  with picked as (
    select c.id
    from public.exec_jobs c
    where c.status = 'queued'
      and c.lane = p_lane
      and c.run_after <= now()
      and (p_kinds is null or c.kind = any(p_kinds))
    order by c.run_after, c.id
    for update skip locked
    limit least(greatest(p_limit, 0), 100)
  )
  update public.exec_jobs j
     set status       = 'running',
         locked_by    = p_worker,
         locked_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 3600)),
         heartbeat_at = now(),
         attempts     = j.attempts + 1,
         started_at   = coalesce(j.started_at, now())
    from picked
   where j.id = picked.id
  returning j.*;
end;
$$;

-- Extend a lease (same 5 s .. 1 h bounds as the claim). Fenced on (id,
-- worker, attempt) and on the lease still being live: returns false when the
-- lease was lost (reaped and re-claimed) or has already expired, so the worker
-- must stop. An expired lease belongs to the reaper, which requeues it on its
-- next pass; renewing it would only delay that. The runner gives a run up
-- before its lease can expire, so a live worker never gets here late.
create or replace function public.exec_heartbeat_job(p_id bigint, p_worker text, p_attempt int, p_lease_seconds int)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with u as (
    update public.exec_jobs
       set locked_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 3600)),
           heartbeat_at = now()
     where id = p_id
       and status = 'running'
       and locked_by = p_worker
       and attempts = p_attempt
       and locked_until >= now()
    returning 1
  )
  select exists (select 1 from u);
$$;

-- Finish a run. Fenced like the heartbeat: a worker whose lease was lost
-- gets false and its outcome is discarded (the re-claimer owns the job now).
--   p_outcome: 'succeeded' | 'retry' | 'dead' | 'cancelled'
--   'retry' re-queues at p_retry_at, or goes 'dead' once attempts are used up.
create or replace function public.exec_finish_job(
  p_id bigint,
  p_worker text,
  p_attempt int,
  p_outcome text,
  p_error text default null,
  p_result jsonb default null,
  p_retry_at timestamptz default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n int;
begin
  -- NULL must be caught here too: `NULL not in (...)` is NULL, so it would
  -- slip past and then fail on the NOT NULL status (or quietly return false
  -- when the fence misses) instead of saying what is wrong.
  if p_outcome is null or p_outcome not in ('succeeded', 'retry', 'dead', 'cancelled') then
    raise exception 'exec_finish_job: bad outcome %', p_outcome;
  end if;

  update public.exec_jobs j
     set status = case
                    when p_outcome = 'retry' and j.attempts >= j.max_attempts then 'dead'
                    when p_outcome = 'retry' then 'queued'
                    else p_outcome
                  end,
         run_after = case
                       when p_outcome = 'retry' and j.attempts < j.max_attempts then coalesce(p_retry_at, now())
                       else j.run_after
                     end,
         finished_at = case
                         when p_outcome = 'retry' and j.attempts < j.max_attempts then null
                         else now()
                       end,
         locked_by = null,
         locked_until = null,
         last_error = case when p_error is null then j.last_error else left(p_error, 2000) end,
         result = case when p_outcome = 'succeeded' then p_result else j.result end
   where j.id = p_id
     and j.status = 'running'
     and j.locked_by = p_worker
     and j.attempts = p_attempt;

  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- Requeue (or kill, when out of attempts) every running job whose lease
-- expired — its worker died, hung or lost the database. Returns the count.
create or replace function public.exec_reap_expired_leases()
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n int;
begin
  update public.exec_jobs j
     set status = case when j.attempts >= j.max_attempts then 'dead' else 'queued' end,
         run_after = now(),
         finished_at = case when j.attempts >= j.max_attempts then now() else null end,
         -- Newest first: last_error is clipped to 2000 chars, and this note
         -- must survive a long error left by an earlier attempt.
         last_error = left(
           'lease expired (worker ' || coalesce(j.locked_by, '?') || ')' || coalesce(' | ' || j.last_error, ''),
           2000
         ),
         locked_by = null,
         locked_until = null
   where j.status = 'running'
     and j.locked_until < now();

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit, access, usage, sync state
-- ---------------------------------------------------------------------------

create table if not exists public.exec_audit_log (
  id           bigint generated always as identity primary key,
  principal_id text references public.exec_principals(id) on delete set null,
  actor        text not null check (actor in ('owner', 'system', 'slack', 'job')),
  action       text not null,
  target       text,
  -- Redacted and size-bounded; message bodies are stripped before insert.
  input        jsonb,
  ok           boolean,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists exec_audit_log_principal_idx on public.exec_audit_log (principal_id, created_at desc);
create index if not exists exec_audit_log_created_idx on public.exec_audit_log (created_at);

create table if not exists public.exec_access_log (
  id           bigint generated always as identity primary key,
  principal_id text references public.exec_principals(id) on delete set null,
  auth_user_id text,
  session_id   text,
  ip           text,
  user_agent   text,
  route        text not null,
  surface      text not null check (surface in ('web', 'slack', 'cron', 'job')),
  created_at   timestamptz not null default now()
);
create index if not exists exec_access_log_principal_idx on public.exec_access_log (principal_id, created_at desc);
create index if not exists exec_access_log_created_idx on public.exec_access_log (created_at);

create table if not exists public.exec_ai_usage (
  id                 bigint generated always as identity primary key,
  principal_id       text references public.exec_principals(id) on delete set null,
  feature            text not null,
  model              text not null,
  input_tokens       int not null default 0,
  output_tokens      int not null default 0,
  cache_read_tokens  int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd           numeric(12, 6) not null default 0,
  latency_ms         int,
  stop_reason        text,
  request_id         text,
  created_at         timestamptz not null default now()
);
create index if not exists exec_ai_usage_principal_idx on public.exec_ai_usage (principal_id, created_at desc);
-- The retention purge deletes by age across all principals.
create index if not exists exec_ai_usage_created_idx on public.exec_ai_usage (created_at);

create table if not exists public.exec_sync_state (
  principal_id text not null references public.exec_principals(id) on delete cascade,
  source       text not null,
  key          text not null,
  cursor       jsonb,
  updated_at   timestamptz not null default now(),
  primary key (principal_id, source, key)
);

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, no policies; service_role only
-- ---------------------------------------------------------------------------

alter table public.exec_principals enable row level security;
alter table public.exec_settings   enable row level security;
alter table public.exec_jobs       enable row level security;
alter table public.exec_audit_log  enable row level security;
alter table public.exec_access_log enable row level security;
alter table public.exec_ai_usage   enable row level security;
alter table public.exec_sync_state enable row level security;

revoke all on public.exec_principals, public.exec_settings, public.exec_jobs, public.exec_audit_log,
              public.exec_access_log, public.exec_ai_usage, public.exec_sync_state
  from public, anon, authenticated;
grant all on public.exec_principals, public.exec_settings, public.exec_jobs, public.exec_audit_log,
             public.exec_access_log, public.exec_ai_usage, public.exec_sync_state
  to service_role;

-- Identity sequences. Inserts don't need these grants (Postgres skips the
-- sequence privilege check for identity columns); this gives service_role
-- direct nextval/currval for maintenance and strips anon/authenticated, which
-- Supabase's stock default privileges grant ALL on new sequences.
do $$
declare
  t text;
  s text;
begin
  foreach t in array array['exec_jobs', 'exec_audit_log', 'exec_access_log', 'exec_ai_usage'] loop
    s := pg_get_serial_sequence('public.' || t, 'id');
    if s is null then
      -- Only possible when a table of this name existed before this file ran
      -- (create table if not exists kept it). Stop instead of half-applying.
      raise exception 'exec foundation aborted, rolled back: public.% has no identity column "id"', t;
    end if;
    execute format('revoke all on sequence %s from public, anon, authenticated', s);
    execute format('grant usage, select on sequence %s to service_role', s);
  end loop;
end $$;

revoke all on function public.exec_claim_jobs(text, text, int, int, text[]) from public, anon, authenticated;
revoke all on function public.exec_heartbeat_job(bigint, text, int, int) from public, anon, authenticated;
revoke all on function public.exec_finish_job(bigint, text, int, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.exec_reap_expired_leases() from public, anon, authenticated;
grant execute on function public.exec_claim_jobs(text, text, int, int, text[]) to service_role;
grant execute on function public.exec_heartbeat_job(bigint, text, int, int) to service_role;
grant execute on function public.exec_finish_job(bigint, text, int, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.exec_reap_expired_leases() to service_role;

-- ---------------------------------------------------------------------------
-- Seed the first principal (the owner) with default settings.
-- ---------------------------------------------------------------------------

insert into public.exec_principals (user_id)
select u.id from public.users u where lower(trim(u.email)) = 'mitchell@scaledai.org'
on conflict (user_id) do nothing;

insert into public.exec_settings (principal_id)
select p.id
from public.exec_principals p
join public.users u on u.id = p.user_id
where lower(trim(u.email)) = 'mitchell@scaledai.org'
on conflict (principal_id) do nothing;

-- So PostgREST sees the new tables/functions without waiting for a restart.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify. The SQL editor shows only the last grid. EXPECT every ok = true.
-- Failing rows sort first, and `detail` then shows the ACL (or the policy
-- names) to fix. Checked for every exec_ table, sequence and function:
--   * RLS on and no policies.
--   * anon/authenticated hold nothing: every table privilege counts
--     (TRUNCATE ignores RLS), and so do column grants and sequences.
--   * service_role can read/write every table, use every sequence and call
--     every RPC; the app reaches all of it only as service_role.
-- ---------------------------------------------------------------------------

select check_name, ok, detail
from (
  select 'owner principal seeded' as check_name,
         exists (select 1 from public.exec_principals p join public.users u on u.id = p.user_id
                 where lower(trim(u.email)) = 'mitchell@scaledai.org' and p.enabled) as ok,
         null::text as detail
  union all
  select 'owner settings seeded',
         exists (select 1 from public.exec_settings s join public.exec_principals p on p.id = s.principal_id
                 join public.users u on u.id = p.user_id where lower(trim(u.email)) = 'mitchell@scaledai.org'),
         null
  union all
  select 'RLS on: ' || c.relname, c.relrowsecurity, null
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind = 'r'
  union all
  select 'no policies: ' || c.relname, pol.names is null, pol.names
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (select string_agg(p.policyname::text, ', ') as names
                      from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) pol
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind = 'r'
  union all
  select 'no anon/authenticated access: ' || c.relname, not x.bad,
         case when x.bad then coalesce(c.relacl::text, '(owner only)') || coalesce(' columns: ' || x.cols, '') end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    select case when c.relkind = 'S' then
                  has_sequence_privilege('anon', c.oid, 'USAGE, SELECT, UPDATE')
                  or has_sequence_privilege('authenticated', c.oid, 'USAGE, SELECT, UPDATE')
                else
                  has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  or has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
                  or has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
           end as bad,
           -- Column grants live on pg_attribute, not in relacl.
           (select string_agg(a.attname::text || ' ' || a.attacl::text, ', ')
            from pg_attribute a where a.attrelid = c.oid and a.attacl is not null) as cols) x
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind in ('r', 'S')
  union all
  select case when c.relkind = 'S' then 'service_role usage: ' else 'service_role access: ' end || c.relname,
         x.good, case when not x.good then coalesce(c.relacl::text, '(owner only)') end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    select case when c.relkind = 'S' then has_sequence_privilege('service_role', c.oid, 'USAGE')
                else has_table_privilege('service_role', c.oid, 'SELECT')
                     and has_table_privilege('service_role', c.oid, 'INSERT')
                     and has_table_privilege('service_role', c.oid, 'UPDATE')
                     and has_table_privilege('service_role', c.oid, 'DELETE')
           end as good) x
  where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind in ('r', 'S')
  union all
  select 'no anon/authenticated execute: ' || p.proname, not x.bad,
         case when x.bad then coalesce(p.proacl::text, '(default: PUBLIC may execute)') end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (select has_function_privilege('anon', p.oid, 'EXECUTE')
                             or has_function_privilege('authenticated', p.oid, 'EXECUTE') as bad) x
  where n.nspname = 'public' and p.proname like 'exec\_%'
  union all
  select 'service_role execute: ' || p.proname, x.good,
         case when not x.good then coalesce(p.proacl::text, '(default: PUBLIC may execute)') end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (select has_function_privilege('service_role', p.oid, 'EXECUTE') as good) x
  where n.nspname = 'public' and p.proname like 'exec\_%'
) checks
order by ok, check_name;
