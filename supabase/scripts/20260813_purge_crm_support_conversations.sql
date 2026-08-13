-- One-time cleanup for the New Life CRM text messages that landed in
-- DelegationDoer's /customer-support tab, after the inbound kill switch
-- (lib/blooio.ts isBlooioInboundEnabled) has been deployed.
--
-- WHY THESE ROWS EXIST
-- DD shares a Blooio ORGANIZATION — and its single number, +1 609 556-3442 —
-- with the New Life Recovery CRM, which runs from a separate codebase and
-- Supabase project. Blooio scopes webhooks to the org rather than to the API
-- key that sent the outbound, and GET /chats returns every chat on the account,
-- so BOTH of DD's inbound paths (the realtime webhook and the 60s polling
-- backstop) ingested the CRM's conversations as if they were ours. The
-- classifier then filed them: terse replies to New Life outreach ("Around 12",
-- "Your time") scored 'uncertain' and stacked up in Needs Review.
--
-- Run this AFTER deploying the kill switch, not before — otherwise the poller
-- re-ingests everything within a minute.
--
-- This is data cleanup, NOT a schema migration — run it manually once against
-- the DD project (Supabase SQL editor or psql), inside the transaction below so
-- you can read the previews and ROLLBACK if anything looks off.
--
-- IT IS A HARD DELETE, and unlike the other purge scripts here it cannot soft-
-- reject: there is no "hidden" state for a support conversation. The message
-- history is not lost globally — it still exists in the CRM's own database and
-- in Blooio itself — but it is gone from DD.
--
-- WHAT IT DELIBERATELY SPARES, each counted separately in the previews:
--   * Operator-composed threads (classifier_output->>'source' =
--     'operator_compose'). Someone at DD started these on purpose from the CS
--     tab; they are our work, whoever the contact is.
--   * Conversations linked to a lead that came in through DD's OWN channels
--     (Typeform / Calendly / manual dashboard entry).
-- It does NOT spare conversations linked to a lead that the inbound router
-- itself minted — routeToLeadFunnel() created those from CRM contacts that
-- classified as 'meta_or_lead', so the link is contamination, not ownership.
-- Their provenance is the 'form_submitted' event payload
-- (source = 'blooio_inbound'), because outbound_leads has no source column.
--
-- Deleting a support_conversations row cascades to support_messages and
-- support_notifications (both FK ... on delete cascade), so the thread bodies
-- and any unseen widget pings go with it. Nothing else references these tables.

begin;

-- ---------------------------------------------------------------------------
-- 1) PREVIEW — the whole table, broken down. Sanity-check the shape first.
-- ---------------------------------------------------------------------------
select
  coalesce(category, '(unclassified)')                as category,
  needs_review,
  linked_lead_id is not null                          as has_lead,
  coalesce(classifier_output->>'source','')
    = 'operator_compose'                              as operator_started,
  count(*)                                            as rows
from public.support_conversations
group by 1, 2, 3, 4
order by rows desc;

-- ---------------------------------------------------------------------------
-- 2) PREVIEW — exactly what step 5 will delete.
-- ---------------------------------------------------------------------------
select count(*) as will_delete
from public.support_conversations c
where coalesce(c.classifier_output->>'source', '') <> 'operator_compose'
  and (
    c.linked_lead_id is null
    or exists (
      select 1
      from public.outbound_lead_events e
      where e.lead_id = c.linked_lead_id
        and e.kind = 'form_submitted'
        and e.payload->>'source' = 'blooio_inbound'
    )
  );

-- ---------------------------------------------------------------------------
-- 3) PREVIEW — what is being SPARED, and why. Expect this to be small.
-- ---------------------------------------------------------------------------
select
  case
    when coalesce(classifier_output->>'source','') = 'operator_compose'
      then 'spared: operator-composed'
    else 'spared: linked to a DD-sourced lead'
  end                                                 as reason,
  count(*)                                            as rows
from public.support_conversations c
where not (
  coalesce(c.classifier_output->>'source', '') <> 'operator_compose'
  and (
    c.linked_lead_id is null
    or exists (
      select 1
      from public.outbound_lead_events e
      where e.lead_id = c.linked_lead_id
        and e.kind = 'form_submitted'
        and e.payload->>'source' = 'blooio_inbound'
    )
  )
)
group by 1;

-- ---------------------------------------------------------------------------
-- 4) EYEBALL THIS ONE BEFORE COMMITTING.
--
-- Conversations the classifier called 'customer_support' are the only place a
-- genuine DD client could be hiding: DD's own leads route to 'meta_or_lead' and
-- are already spared above, so anything here is either a real customer who
-- texted the shared number or — far more likely, since the number is New Life's
-- — a misclassified CRM contact. Read the rows. If you recognise a real client,
-- stop, ROLLBACK, and add their phone to an exclusion before re-running.
-- ---------------------------------------------------------------------------
select
  c.phone,
  c.contact_name,
  c.status,
  c.assigned_to,
  c.last_message_at,
  left(coalesce(c.last_message_preview, ''), 120)     as preview,
  c.classifier_output->>'reason'                      as classifier_reason
from public.support_conversations c
where c.category = 'customer_support'
  and coalesce(c.classifier_output->>'source', '') <> 'operator_compose'
  and c.linked_lead_id is null
order by c.last_message_at desc nulls last
limit 50;

-- ---------------------------------------------------------------------------
-- 5) DELETE. Cascades to support_messages + support_notifications.
-- ---------------------------------------------------------------------------
delete from public.support_conversations c
where coalesce(c.classifier_output->>'source', '') <> 'operator_compose'
  and (
    c.linked_lead_id is null
    or exists (
      select 1
      from public.outbound_lead_events e
      where e.lead_id = c.linked_lead_id
        and e.kind = 'form_submitted'
        and e.payload->>'source' = 'blooio_inbound'
    )
  );

-- ---------------------------------------------------------------------------
-- 6) VERIFY — what survives, and that no orphans are left behind.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.support_conversations)  as conversations_left,
  (select count(*) from public.support_messages)       as messages_left,
  (select count(*) from public.support_notifications)  as notifications_left,
  (select count(*) from public.support_conversations
     where needs_review = true)                        as needs_review_left;

-- ---------------------------------------------------------------------------
-- This file ends in ROLLBACK on purpose, unlike the other purge scripts here.
-- They soft-reject rows; this one hard-deletes, so running the whole file is a
-- DRY RUN — every preview prints, the delete is exercised (row counts are real,
-- FK cascades are proven), and then nothing is kept.
--
-- To actually apply it: re-run and issue COMMIT; in place of the ROLLBACK
-- below, after reading step 4's output.
-- ---------------------------------------------------------------------------
rollback;


-- ===========================================================================
-- OPTIONAL PART 2 — the CRM contacts sitting in DD's OUTBOUND LEAD funnel.
--
-- Not part of the Customer Support cleanup, and NOT run by default. Flagged
-- here because the same contamination path produced it: when a CRM text
-- classified as 'meta_or_lead', routeToLeadFunnel() minted a real
-- public.outbound_leads row for that person. Those rows show up on
-- /outbound-dashboard/leads as though they were DD prospects.
--
-- They are inert — createLeadManual was called with startSequence:false, so no
-- drip was ever scheduled and DD has not texted them. This is a tidiness and
-- data-hygiene question, not an active problem, which is why it is separated.
--
-- Deleting a lead cascades outbound_lead_events and outbound_scheduled_messages
-- and SETs NULL on any support_conversations.linked_lead_id still pointing at
-- it. Run PART 1 first so that last case doesn't arise.
--
-- Preview first; uncomment the delete only if you want them gone.
-- ===========================================================================

-- begin;
--
-- select l.phone, l.name, l.email, l.status, l.created_at
-- from public.outbound_leads l
-- where exists (
--   select 1 from public.outbound_lead_events e
--   where e.lead_id = l.id
--     and e.kind = 'form_submitted'
--     and e.payload->>'source' = 'blooio_inbound'
-- )
-- order by l.created_at desc;
--
-- delete from public.outbound_leads l
-- where exists (
--   select 1 from public.outbound_lead_events e
--   where e.lead_id = l.id
--     and e.kind = 'form_submitted'
--     and e.payload->>'source' = 'blooio_inbound'
-- );
--
-- rollback;  -- swap for COMMIT once the preview looks right.
