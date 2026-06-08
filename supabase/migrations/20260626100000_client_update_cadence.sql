-- Per-client cadence for the EOD-digest email queue.
--
-- daily      → digest builder fires every time someone submits an EOD
--              that touched this client (live, plus a nightly safety net)
-- biweekly   → digest builder fires on Wednesday and Friday only
-- weekly     → digest builder fires on Friday only
-- monthly    → digest builder fires on the 1st of every month
-- none       → opt-out; no digests are queued for this client at all
--
-- Defaults to 'daily' so back-compat with the just-shipped digest path
-- is preserved. Workers can't change this directly — the picker on
-- the client detail page is leader/head/admin only, same gate as the
-- existing PATCH /api/clients/[id] fields.

alter table public.clients
  add column if not exists update_cadence text not null default 'daily';

-- Enforce the four supported values. Existing 'daily' default satisfies
-- the constraint for every pre-existing row.
do $$
begin
  alter table public.clients drop constraint if exists clients_update_cadence_check;
  alter table public.clients
    add constraint clients_update_cadence_check
    check (update_cadence in ('daily', 'biweekly', 'weekly', 'monthly', 'none'));
exception when others then
  raise notice 'cadence check constraint: %', sqlerrm;
end $$;
