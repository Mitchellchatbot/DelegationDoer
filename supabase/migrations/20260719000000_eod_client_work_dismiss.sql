-- Discard support for EOD client-work entries. The Client Update composer
-- lists a client's unreported entries as a checklist; entries the operator
-- doesn't want to send used to linger forever (only emailed entries get
-- reported_to_client_at stamped), so leftovers kept re-appearing in the
-- composer and the "Who needs an email" card. dismissed_at lets the operator
-- discard unwanted work without sending an email — distinct from
-- reported_to_client_at so reported-work analytics stay honest. Mirrors the
-- archived_at/deleted_at audit pattern (a nullable timestamp + the actor).

alter table public.eod_client_work
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by text references public.users(id) on delete set null;
