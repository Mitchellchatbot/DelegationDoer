-- The Clients → Bulk Send "Monthly SEO update" tool blasts one email to many
-- clients (one outbound Missive thread each). Those mass sends must NOT reset a
-- client's touchpoint health, or every client lights up green the moment a blast
-- goes out, hiding the ones that genuinely need a personal touch.
--
-- The primary exclusion is a per-message `automated` flag the bulk tool sets on
-- the clone (touchpoint-sync skips it). But that depends on the missiveclone
-- backend persisting/returning is_automated — which an older clone build may
-- drop. This table is a clone-independent backstop: the bulk route logs every
-- thread it created here, and touchpoint-sync skips any SENT thread whose id is
-- recorded. Covers immediate sends regardless of clone behavior (scheduled
-- blasts have no thread id at send time, so they still rely on the flag).

create table if not exists public.bulk_email_threads (
  thread_id   text primary key,
  client_id   text references public.clients(id) on delete cascade,
  subject     text,
  sent_by     text,            -- users.id of the approver; no FK (kept simple)
  sent_at     timestamptz not null default now()
);

create index if not exists bulk_email_threads_sent_at_idx
  on public.bulk_email_threads(sent_at desc);
