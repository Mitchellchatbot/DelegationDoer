-- Outbound funnel tables — Typeform → Calendly → Blooio automation.
--
-- Three tables together model the whole flow:
--   1. outbound_leads             — one row per person in the funnel,
--                                    with a status field that drives the
--                                    state machine (warm_lead → booked →
--                                    showed → success | no_show | lost).
--   2. outbound_lead_events       — append-only timeline. Every state
--                                    transition, every SMS send, every
--                                    manual mark gets a row here so the
--                                    dashboard can render an activity feed
--                                    and the team can audit what happened.
--   3. outbound_scheduled_messages — the queue powering every timed SMS.
--                                    A claim-before-send pattern (status
--                                    pending → sending) is used by the
--                                    cron runner to dispatch idempotently.
--
-- Status values are plain text (not enum types) so adding a new status
-- ("paused", "needs_review") is a no-rewrite, no-migration change. The
-- application enforces valid transitions in lib/outbound-leads.ts.
--
-- RLS: tables are not exposed to anon. All reads/writes go through the
-- service role (server-side helpers) — the dashboard fetches via Next.js
-- server components, the webhooks run server-side, the cron runner uses
-- the admin client. No client browser ever talks to these tables.

-- ============================================================================
-- outbound_leads
-- ============================================================================
create table if not exists public.outbound_leads (
  id                      uuid primary key default gen_random_uuid(),
  -- E.164 phone (e.g. "+15125550100"). Unique — the dedup key when the
  -- same person fills the form twice or moves through Calendly twice.
  phone                   text not null unique,
  email                   text,
  name                    text,
  -- State machine. Allowed values are enforced by the check constraint;
  -- the application layer (lib/outbound-leads.ts:transitionLead) gates
  -- which transitions are legal.
  status                  text not null default 'warm_lead'
                          check (status in (
                            'warm_lead', 'booked', 'showed',
                            'no_show', 'success', 'lost'
                          )),
  -- Sales rep this lead is attributed to (optional). Drives SMS sender
  -- persona personalization in a later phase. NB: public.users.id is
  -- text (not uuid) — see e.g. 20260505000000_init.sql.
  assigned_rep_id         text references public.users(id) on delete set null,
  -- Dedup key for Typeform — Typeform sends `event_id` per submission;
  -- a retried webhook delivery uses the same id, so the unique constraint
  -- makes the upsert idempotent.
  typeform_response_id    text unique,
  typeform_payload        jsonb,
  -- Calendly state — set on invitee.created, nulled on invitee.canceled.
  calendly_event_uri      text,
  meeting_starts_at       timestamptz,
  meeting_ends_at         timestamptz,
  -- Manual marks. The presence of a timestamp is the source of truth for
  -- "happened"; the status column is a denormalized convenience for the
  -- dashboard.
  sold_at                 timestamptz,
  sold_notes              text,
  no_show_at              timestamptz,
  marked_lost_at          timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists outbound_leads_status_idx
  on public.outbound_leads (status, created_at desc);
create index if not exists outbound_leads_phone_idx
  on public.outbound_leads (phone);

-- Auto-bump updated_at on every UPDATE so the dashboard's "last activity"
-- column reflects the real edit time without callers having to remember.
create or replace function public.outbound_leads_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists outbound_leads_touch on public.outbound_leads;
create trigger outbound_leads_touch
  before update on public.outbound_leads
  for each row execute function public.outbound_leads_touch_updated_at();

alter table public.outbound_leads enable row level security;

-- ============================================================================
-- outbound_lead_events
-- ============================================================================
create table if not exists public.outbound_lead_events (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.outbound_leads(id) on delete cascade,
  -- Event kind. Append-only — we never UPDATE a row here. New kinds are
  -- added as the funnel grows; the check constraint can be relaxed in
  -- a later migration.
  kind         text not null check (kind in (
    'form_submitted',
    'meeting_booked',
    'meeting_canceled',
    'first_text_sent',
    'reminder_24h_sent',
    'reminder_1h_sent',
    'drip_sent',
    'marked_no_show',
    'marked_showed',
    'marked_sold',
    'marked_lost',
    'sequence_completed',
    'transitioned'  -- generic state-machine transition (from/to in payload)
  )),
  payload      jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists outbound_lead_events_lead_idx
  on public.outbound_lead_events (lead_id, created_at desc);
create index if not exists outbound_lead_events_kind_idx
  on public.outbound_lead_events (kind, created_at desc);

alter table public.outbound_lead_events enable row level security;

-- ============================================================================
-- outbound_scheduled_messages
-- ============================================================================
create table if not exists public.outbound_scheduled_messages (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid not null references public.outbound_leads(id) on delete cascade,
  -- Message kind drives copy choice + cancellation rules. confirmation /
  -- reminder_24h / reminder_1h are one-shots scheduled around a meeting.
  -- recovery_drip / engagement_drip are 5-message sequences spread over
  -- 30 days; sequence_index identifies which step (1..N).
  kind                text not null check (kind in (
    'confirmation', 'reminder_24h', 'reminder_1h',
    'recovery_drip', 'engagement_drip'
  )),
  sequence_index      int not null default 1,
  -- Body is pre-rendered at schedule time (placeholders filled). Stored
  -- here verbatim so audits + the lead detail page can show exactly what
  -- went out, even if templates change later.
  body                text not null,
  scheduled_for       timestamptz not null,
  -- Claim-before-send queue states. pending → sending → sent | failed,
  -- or pending → canceled when a state transition kills the sequence.
  status              text not null default 'pending'
                      check (status in (
                        'pending', 'sending', 'sent', 'failed', 'canceled'
                      )),
  sent_at             timestamptz,
  blooio_message_id   text,
  error               text,
  created_at          timestamptz not null default now()
);

-- The runner's claim query — pulls due rows in priority order.
create index if not exists outbound_scheduled_messages_due_idx
  on public.outbound_scheduled_messages (status, scheduled_for)
  where status = 'pending';

-- Per-lead cancellation lookup (cancel all pending of a given kind when
-- a state transition fires).
create index if not exists outbound_scheduled_messages_lead_kind_idx
  on public.outbound_scheduled_messages (lead_id, kind, status);

alter table public.outbound_scheduled_messages enable row level security;
