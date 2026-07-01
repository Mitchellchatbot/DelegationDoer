import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { MODELS } from "@/lib/anthropic-client";
import {
  classifySupportMessage, type SupportCategory, type SupportClassification
} from "@/lib/support-classifier";
import {
  getConversation, getConversationByChatId, listMessages, type SupportConversation
} from "@/lib/support-data";
import {
  findLeadByPhone, getLeadById, createLeadManual,
  scheduleRecoveryDrip, hasPendingRecoveryDrip, recordEvent
} from "@/lib/outbound-leads";
import { isFormEnrolledInFlow } from "@/lib/outbound-typeform-forms";
import { notifyFormSubmitted } from "@/lib/outbound-slack";

// The single entry point both inbound capture paths funnel through — the
// real-time Blooio webhook AND the polling-cron backstop. It is idempotent by
// design so the two can race (or a webhook can retry) without double-creating
// conversations, messages, leads, or Slack pings:
//
//   1. UPSERT conversation by blooio_chat_id (UNIQUE)        — one row per chat
//   2. INSERT message ON CONFLICT(blooio_message_id) NOTHING — one row per text
//   3. classify-once: the category flip is a conditional UPDATE (... where
//      category is null), so exactly one worker routes the conversation.
//
// Routing (first inbound only):
//   - known-lead phone  → meta_or_lead (skip the LLM; already a funnel lead)
//   - else classify     → customer_support | meta_or_lead | uncertain
//   - meta_or_lead      → createLeadManual (no SMS drip) + link + Slack ping
//   - uncertain         → needs_review = true (Needs Review queue)
//   - customer_support  → stays in the support inbox

export interface IngestResult {
  conversationId: string;
  // duplicate  = message already ingested (no-op).
  // appended   = persisted, but no new classification (outbound, or already
  //              categorized, or another worker classified first).
  // classified = this call ran the first classification + routing.
  outcome: "duplicate" | "appended" | "classified";
  category?: SupportCategory | null;
}

export interface InboundMessageInput {
  chatId: string;            // Blooio chat id == contact E.164 phone
  phone: string;
  contactName: string | null;
  blooioMessageId: string;
  body: string;
  sentAt: string;            // ISO timestamp
  direction: "inbound" | "outbound";
}

export async function ingestInboundMessage(input: InboundMessageInput): Promise<IngestResult> {
  const supabase = getSupabaseAdmin();
  const { chatId, phone, contactName, blooioMessageId, body, sentAt, direction } = input;

  // 1. Resolve the conversation. Inbound CREATES it (the upsert IS the lock
  //    against the webhook+poll race); outbound only APPENDS to an existing one.
  //    An outbound message for a chat we don't track yet would otherwise mint an
  //    invisible, category-null orphan (shown in neither inbox bucket), so we
  //    skip it — our own replies always have a pre-existing conversation.
  let convo: SupportConversation | null;
  if (direction === "inbound") {
    const { error: upsertErr } = await supabase
      .from("support_conversations")
      .upsert(
        { blooio_chat_id: chatId, phone, contact_name: contactName },
        { onConflict: "blooio_chat_id", ignoreDuplicates: true }
      );
    if (upsertErr) throw new Error(upsertErr.message);
    convo = await getConversationByChatId(chatId);
    if (!convo) throw new Error(`support_conversations row missing after upsert for ${chatId}`);
  } else {
    convo = await getConversationByChatId(chatId);
    if (!convo) {
      return { conversationId: "", outcome: "duplicate" };
    }
  }

  // 2. Message insert, deduped on blooio_message_id. ignoreDuplicates →
  //    ON CONFLICT DO NOTHING; .select() returns the inserted row(s) only, so
  //    an empty result means we've already ingested this message.
  const { data: insertedRows, error: msgErr } = await supabase
    .from("support_messages")
    .upsert(
      {
        conversation_id: convo.id,
        blooio_message_id: blooioMessageId,
        direction,
        body,
        sent_at: sentAt
      },
      { onConflict: "blooio_message_id", ignoreDuplicates: true }
    )
    .select("id");
  if (msgErr) throw new Error(msgErr.message);
  if ((insertedRows?.length ?? 0) === 0) {
    return { conversationId: convo.id, outcome: "duplicate" };
  }

  // 3. Bump conversation activity columns (only if this message is the newest,
  //    so an out-of-order poll/webhook delivery can't rewind the preview).
  await touchConversationActivity(convo, { sentAt, body, direction, contactName });

  // 4. Outbound replies never classify.
  if (direction !== "inbound") {
    return { conversationId: convo.id, outcome: "appended" };
  }

  // 5. Already categorized → just an appended inbound message.
  if (convo.category) {
    return { conversationId: convo.id, outcome: "appended", category: convo.category };
  }

  // 6. First inbound on an un-categorized conversation → classify.
  const classification = await classifyOrShortCircuit(convo, phone, body, contactName);

  // 7. Single-winner category flip. The `is("category", null)` guard means
  //    only the first worker to get here actually flips + routes; a concurrent
  //    duplicate delivery that lost the message-dedup race but reached here
  //    finds category already set and skips the side-effects.
  const needsReview = classification.category === "uncertain";
  const { data: flipped, error: flipErr } = await supabase
    .from("support_conversations")
    .update({
      category: classification.category,
      classifier_output: { ...classification, model: MODELS.classify },
      needs_review: needsReview
    })
    .eq("id", convo.id)
    .is("category", null)
    .select("id");
  if (flipErr) throw new Error(flipErr.message);
  if ((flipped?.length ?? 0) === 0) {
    return { conversationId: convo.id, outcome: "appended" };
  }

  // 8. Route side-effects (exactly once — we won the flip above).
  if (classification.category === "meta_or_lead") {
    await routeToLeadFunnel(convo, phone, contactName);
  }

  return {
    conversationId: convo.id,
    outcome: "classified",
    category: classification.category
  };
}

// Known-lead phones skip the LLM entirely: a number already in outbound_leads
// is, by definition, a Meta/ads lead. Otherwise classify with conversation
// context.
async function classifyOrShortCircuit(
  convo: SupportConversation,
  phone: string,
  body: string,
  contactName: string | null
): Promise<SupportClassification> {
  const knownLead = convo.linkedLeadId
    ? await getLeadById(convo.linkedLeadId)
    : await findLeadByPhone(phone);
  if (knownLead) {
    return {
      category: "meta_or_lead",
      confidence: "high",
      reason: "Phone already exists in the outbound lead funnel."
    };
  }
  const history = await listMessages(convo.id);
  // A media-only / empty first text (MMS image, sticker, bare emoji that arrives
  // as empty text) gives the classifier nothing to decide on — skip the LLM call
  // and park it for a human, the same outcome the model would reach anyway.
  const hasInboundText = history.some((m) => m.direction === "inbound" && m.body.trim().length > 0);
  if (!body.trim() && !hasInboundText) {
    return {
      category: "uncertain",
      confidence: "low",
      reason: "Media-only/empty inbound — no text to classify yet."
    };
  }
  return classifySupportMessage({
    body,
    contactName,
    phone,
    recentMessages: history.map((m) => ({ direction: m.direction, body: m.body }))
  });
}

// Feed a routed lead into the EXISTING outbound funnel. Reuses createLeadManual
// (dedups by phone→email, returns isNew) with startSequence:false, so a
// brand-new SMS number is created WITHOUT a drip (it has no originating
// typeform to enroll from). When we instead MATCH an existing lead, we respect
// that lead's typeform "add to flow" scope: if its form is enrolled and the
// lead is a warm_lead not already mid-drip, we (re-)enroll it in the recovery
// drip — treating the inbound text as re-engagement. Guarded against
// double-scheduling a live sequence. Slack ping only for a genuinely new lead
// (mirrors the typeform webhook's isNew gate).
async function routeToLeadFunnel(
  convo: SupportConversation,
  phone: string,
  contactName: string | null
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { lead, isNew } = await createLeadManual({
    phone,
    email: null,
    name: contactName,
    typeformFormId: null,
    startSequence: false,
    createdBy: "system:blooio-support",
    source: "blooio_inbound"
  });
  await supabase
    .from("support_conversations")
    .update({ linked_lead_id: lead.id })
    .eq("id", convo.id);

  if (isNew) {
    // Brand-new SMS number: create + notify, but start no flow (no form scope).
    await notifyFormSubmitted(lead); // best-effort; swallows its own errors.
    return;
  }

  // Matched an EXISTING lead — follow its typeform's add-to-flow toggle.
  // Only enroll when: the lead's form is enrolled, the lead is still a warm_lead
  // (not booked/showed/sold/lost), and it isn't already mid-recovery-drip.
  if (
    lead.phone &&
    lead.status === "warm_lead" &&
    lead.typeformFormId &&
    (await isFormEnrolledInFlow(lead.typeformFormId)) &&
    !(await hasPendingRecoveryDrip(lead.id))
  ) {
    await scheduleRecoveryDrip(lead);
    await recordEvent(lead.id, "sequence_changed", {
      source: "blooio_inbound",
      action: "enrolled_recovery_drip"
    });
  }
}

// Manual reclassification from the CS-tab Needs Review queue.
//   - "support": re-point the conversation into the support inbox. Does NOT
//     delete any linked outbound_leads row — reclassify changes the
//     conversation's surface, not the lead's existence.
//   - "lead": route into the outbound funnel now (idempotent — createLeadManual
//     dedups, so re-running on an already-linked conversation is a no-op).
export async function reclassifyConversation(
  conversationId: string,
  to: "support" | "lead"
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const convo = await getConversation(conversationId);
  if (!convo) throw new Error(`conversation not found: ${conversationId}`);

  // Only Needs-Review (uncertain) conversations are reclassifiable. This guards
  // a stale tab: if the conversation was already triaged elsewhere, a leftover
  // "→ Lead"/"→ Support" click here is a no-op rather than (for "lead") minting
  // a spurious outbound_leads row + Slack ping on an already-support thread.
  if (!convo.needsReview) return;

  if (to === "support") {
    await supabase
      .from("support_conversations")
      .update({ category: "customer_support", needs_review: false })
      .eq("id", convo.id);
    return;
  }

  // to === "lead"
  if (convo.phone) {
    await routeToLeadFunnel(convo, convo.phone, convo.contactName);
  }
  await supabase
    .from("support_conversations")
    .update({ category: "meta_or_lead", needs_review: false })
    .eq("id", convo.id);
}

async function touchConversationActivity(
  convo: SupportConversation,
  msg: { sentAt: string; body: string; direction: "inbound" | "outbound"; contactName: string | null }
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const patch: Record<string, unknown> = {};
  if (!convo.lastMessageAt || msg.sentAt >= convo.lastMessageAt) {
    patch.last_message_at = msg.sentAt;
    patch.last_message_preview = msg.body.slice(0, 200);
  }
  if (msg.direction === "inbound" && (!convo.lastInboundAt || msg.sentAt >= convo.lastInboundAt)) {
    patch.last_inbound_at = msg.sentAt;
  }
  if (msg.contactName && !convo.contactName) {
    patch.contact_name = msg.contactName;
  }
  // A customer texting back into a closed thread re-opens it so it returns to
  // the support inbox (otherwise a resolved-then-replied conversation is lost).
  if (msg.direction === "inbound" && convo.status === "closed") {
    patch.status = "open";
  }
  if (Object.keys(patch).length === 0) return;
  await supabase.from("support_conversations").update(patch).eq("id", convo.id);
}

// Re-link conversations that classified as a lead but lost their lead link to a
// transient error after the category flip (createLeadManual is now idempotent,
// so the remaining gap is only a failure on the linked_lead_id UPDATE itself).
// Idempotent and bounded — run from the poller each sweep.
export async function reconcileUnlinkedLeadConversations(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("support_conversations")
    .select("id")
    .eq("category", "meta_or_lead")
    .is("linked_lead_id", null)
    .limit(50);
  if (error) throw new Error(error.message);

  let fixed = 0;
  for (const row of (data ?? []) as Array<{ id: string }>) {
    const convo = await getConversation(row.id);
    if (!convo || !convo.phone || convo.linkedLeadId) continue;
    try {
      await routeToLeadFunnel(convo, convo.phone, convo.contactName);
      fixed++;
    } catch (err) {
      console.error("[support-intake] reconcile unlinked lead failed", {
        conversationId: row.id,
        error: err instanceof Error ? err.message : err
      });
    }
  }
  return fixed;
}

// Persist an outbound reply we just sent through Blooio. Used by the reply API
// route. Blooio may not return a message_id, so the caller synthesizes a
// stable local id to satisfy the NOT NULL UNIQUE column.
export async function recordOutboundMessage(input: {
  chatId: string;
  blooioMessageId: string;
  body: string;
  sentAt: string;
}): Promise<void> {
  await ingestInboundMessage({
    chatId: input.chatId,
    phone: input.chatId,
    contactName: null,
    blooioMessageId: input.blooioMessageId,
    body: input.body,
    sentAt: input.sentAt,
    direction: "outbound"
  });
}
