-- CEO-controlled priority order for clients. Lower display_order = higher
-- on the list (most urgent). The existing `priority` enum (low/medium/high)
-- stays as a coarse tag, but display_order is the canonical sort key.
--
-- Numeric (not int) so we can insert between two existing entries without
-- renumbering — drag-drop persists fractional ranks like 1.5, 2.5 — the
-- application can periodically renumber if drift gets large.

alter table public.clients
  add column if not exists display_order numeric not null default 0;

-- Seed sensible initial values: alphabetical ordering, gapped by 100 so
-- inserts have room. Idempotent — re-running doesn't change rows that
-- already have a non-zero display_order.
update public.clients c
   set display_order = r.rn * 100
  from (
    select id, row_number() over (order by name) as rn
      from public.clients
     where display_order = 0
  ) r
 where c.id = r.id and c.display_order = 0;

create index if not exists clients_display_order_idx on public.clients (display_order);
