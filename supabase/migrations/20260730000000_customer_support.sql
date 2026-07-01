-- Customer Support inbox — inbound Blooio SMS capture + AI routing.
--
-- The Blooio number is shared between customer support and Meta/Facebook-ads
-- lead follow-up. Every inbound text is AI-classified and routed:
--   - customer_support → shown in the new /customer-support inbox tab
--   - meta_or_lead     → fed into the existing outbound_leads funnel
--                        (surfaces on /outbound-dashboard/leads)
--   - uncertain        → the "Needs Review" queue inside the CS tab
--
-- This is its own isolated module (mirrors the outbound funnel): two tables,
-- accessed only through the service-role admin client from server code. The
-- webhook + the poller cron both write here through lib/support-intake.ts.
--
-- Conventions (see 20260711000000_outbound_funnel.sql):
--   - uuid PKs (gen_random_uuid()) so linked_lead_id can FK into
--     outbound_leads.id (which is uuid, NOT the core app's text ids).
--   - public.users.id is TEXT — assigned_to is text.
--   - enum-like columns are plain text + CHECK (no PG enum types) so adding
--     a category/status later is a no-rewrite change.
--   - RLS enabled, zero policies: anon never reads these; all access is via
--     getSupabaseAdmin() which bypasses RLS.

begin;

-- ============================================================================
-- support_conversations — one row per Blooio chat (= one contact phone)
-- ============================================================================
create table if not exists public.support_conversations (
  id                   uuid primary key default gen_random_uuid(),
  -- Blooio chat id == the contact's E.164 phone. UNIQUE so the webhook and
  -- the poller can never create two conversation rows for the same chat
  -- (upsert-then-select uses this as the lock).
  blooio_chat_id       text not null unique,
  phone                text not null,
  contact_name         text,
  -- Routing classification. NULL until the first inbound message is
  -- classified; the CHECK still permits NULL.
  category             text check (category in (
                         'customer_support', 'meta_or_lead', 'uncertain'
                       )),
  -- Support workflow state (open inbox vs resolved/closed).
  status               text not null default 'open'
                       check (status in ('open', 'closed')),
  -- True while category = 'uncertain' (drives the Needs Review queue).
  needs_review         boolean not null default false,
  -- Set when the conversation routes to the outbound funnel. uuid FK into
  -- outbound_leads; SET NULL if the lead row is ever deleted.
  linked_lead_id       uuid references public.outbound_leads(id) on delete set null,
  -- Audit of the AI decision: { category, confidence, reason, model, ... }.
  classifier_output    jsonb,
  last_message_at      timestamptz,
  last_inbound_at      timestamptz,
  last_message_preview text,
  -- Optional CS owner. users.id is TEXT.
  assigned_to          text references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists support_conversations_inbox_idx
  on public.support_conversations (category, last_message_at desc);
create index if not exists support_conversations_review_idx
  on public.support_conversations (last_message_at desc)
  where needs_review = true;

-- updated_at touch trigger (mirrors outbound_leads_touch_updated_at).
create or replace function public.support_conversations_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists support_conversations_touch on public.support_conversations;
create trigger support_conversations_touch
  before update on public.support_conversations
  for each row execute function public.support_conversations_touch_updated_at();

alter table public.support_conversations enable row level security;

-- ============================================================================
-- support_messages — append-only log of every inbound + outbound SMS
-- ============================================================================
create table if not exists public.support_messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null
                    references public.support_conversations(id) on delete cascade,
  -- Cross-source dedup key. The webhook, the poller, AND webhook retries all
  -- key on this so a message is ingested exactly once. For an outbound reply
  -- where Blooio returns no message_id we synthesize "local:<convo>:<ts>".
  blooio_message_id text not null unique,
  direction         text not null check (direction in ('inbound', 'outbound')),
  body              text not null default '',
  sent_at           timestamptz not null,
  created_at        timestamptz not null default now()
);

create index if not exists support_messages_convo_idx
  on public.support_messages (conversation_id, sent_at);

alter table public.support_messages enable row level security;

commit;
