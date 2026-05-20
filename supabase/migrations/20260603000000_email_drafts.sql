-- Email-approval queue. Workers compose outbound client emails (from
-- the EOD client-email composer, the SEO Content Plan flow, or a
-- future ad-hoc compose surface) and they land here in 'pending'
-- status. Mitch / Mujtaba / Sam (per kind) review, then approve →
-- which fires the actual send through missiveclone using the author's
-- linked mailbox.
--
-- Kept generic so future surfaces (ranking updates, monthly reports,
-- custom) can drop drafts in without schema changes.

create table if not exists email_drafts (
  id              text primary key,
  -- Worker who composed it. Send goes from their connected inbox.
  author_id       text not null references public.users(id) on delete cascade,
  -- Missive account id used as the sending mailbox. nullable because
  -- the author might not have a connected mailbox yet at draft time —
  -- the approve endpoint enforces presence before send.
  account_id      text,
  -- Client linkage. Free-text client_name is the source of truth for
  -- display + Slack messages (so a deleted client row doesn't lose
  -- the receipt); client_id is the FK for joins.
  client_id       text references public.clients(id) on delete set null,
  client_name     text not null,
  -- Recipients. to is mandatory; cc/bcc are optional arrays.
  to_emails       text[] not null,
  cc_emails       text[] not null default '{}',
  bcc_emails      text[] not null default '{}',
  subject         text not null,
  body_text       text not null,
  body_html       text,
  -- Surface that produced this draft. Drives the approver routing
  -- (client_update → Mitch/Mujtaba/Sam; content_plan → 6-person
  -- broader set per spec Section 3B; custom → Mitch only).
  kind            text not null check (kind in ('client_update', 'content_plan', 'custom')),
  status          text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'sent', 'failed')),
  -- Approver bookkeeping. Set when status flips out of 'pending'.
  approver_id     text references public.users(id) on delete set null,
  approved_at     timestamptz,
  rejected_at     timestamptz,
  rejection_note  text,
  -- Send receipt — populated when missiveclone confirms delivery.
  -- send_error captures the upstream failure so retries can diagnose.
  missive_thread_id  text,
  missive_message_id text,
  sent_at         timestamptz,
  send_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists email_drafts_status_idx
  on email_drafts(status, created_at desc);
create index if not exists email_drafts_kind_status_idx
  on email_drafts(kind, status, created_at desc);
create index if not exists email_drafts_author_idx
  on email_drafts(author_id, created_at desc);
create index if not exists email_drafts_client_idx
  on email_drafts(client_id, created_at desc)
  where client_id is not null;

create or replace function public.set_email_drafts_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists email_drafts_set_updated_at on public.email_drafts;
create trigger email_drafts_set_updated_at
  before update on public.email_drafts
  for each row execute function public.set_email_drafts_updated_at();
