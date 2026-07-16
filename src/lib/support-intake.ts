import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { MODELS } from "@/lib/anthropic-client";
import {
  classifySupportMessage, type SupportCategory, type SupportClassification
} from "@/lib/support-classifier";
import {
  getConversation, getConversationByChatId, listMessages, normalizeConversation,
  type ConversationRow, type SupportConversation
} from "@/lib/support-data";
import { findLeadByPhone, getLeadById, createLeadManual } from "@/lib/outbound-leads";
import { notifyFormSubmitted } from "@/lib/outbound-slack";
import { fanOutSupportMessage } from "@/lib/support-notifications";

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

  // 5. Already categorized → just an appended inbound message. If it lives in
  //    the Customer Support tab (customer_support or uncertain), ping the
  //    support team's widget — this covers customer replies on an existing or
  //    reopened thread, not just the first message.
  if (convo.category) {
    if (convo.category === "customer_support" || convo.category === "uncertain") {
      await fanOutSupportMessage({
        conversationId: convo.id,
        messageId: blooioMessageId,
        contactName: convo.contactName ?? contactName,
        phone: convo.phone ?? phone,
        body,
        sentAt,
        category: convo.category
      });
    }
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

  // 8. Route side-effects (exactly once — we won the flip above). A meta_or_lead
  //    goes to the outbound funnel (its own Slack ping); a customer_support or
  //    uncertain message lands in the CS tab, so ping the support team's widget.
  if (classification.category === "meta_or_lead") {
    await routeToLeadFunnel(convo, phone, contactName);
  } else if (
    classification.category === "customer_support" ||
    classification.category === "uncertain"
  ) {
    await fanOutSupportMessage({
      conversationId: convo.id,
      messageId: blooioMessageId,
      contactName: convo.contactName ?? contactName,
      phone: convo.phone ?? phone,
      body,
      sentAt,
      category: classification.category
    });
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
// (dedups by phone→email, returns isNew) — no new SMS drip is started
// (startSequence:false) because the person already texted us. Only ping Slack
// for a genuinely new lead, mirroring the typeform webhook's isNew gate.
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
    // Best-effort; notifyFormSubmitted swallows its own errors.
    await notifyFormSubmitted(lead);
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

// Create (or find) the conversation for an operator-composed outbound text —
// the compose route's pre-step. Inbound capture normally creates conversations;
// compose is the one path that starts a thread with a number that has never
// texted us, so the row must exist BEFORE recordOutboundMessage runs (step 1
// drops outbound messages for unknown chats on the grounds that they'd mint a
// category-null orphan, visible in neither bucket — pre-creating with a
// non-null category is exactly what that guard asks for, so it stays as-is).
//
// Race-safe by the same lock as the inbound path: blooio_chat_id is UNIQUE, so
// two operators composing to one number collapse to a single row.
export async function ensureOperatorConversation(input: {
  // MUST already be E.164 — this string becomes blooio_chat_id, and it has to
  // byte-match what the inbound path stores (Blooio's chat id, verbatim) or one
  // human ends up with two conversation rows that UNIQUE cannot collapse.
  phone: string;
  contactName: string | null;
  createdBy: string;
}): Promise<{ conversation: SupportConversation; isNew: boolean }> {
  const supabase = getSupabaseAdmin();
  const { phone, contactName, createdBy } = input;

  // Category mirrors classifyOrShortCircuit's rule rather than inventing a
  // second one: a phone already in outbound_leads IS a funnel lead, so texting
  // it from the CS tab must not launder it into the support inbox.
  //
  // This lookup carries more weight than it looks. A lead who has only received
  // drip SMS has no conversation row at all (the sequence runner sends via
  // Blooio but never calls recordOutboundMessage), and ingestInboundMessage
  // skips classification on any non-null category — so a wrong customer_support
  // written here could never be corrected by the classifier later.
  // findLeadByPhone is an exact .eq("phone", ...) with no normalization of its
  // own; it only matches because `phone` is already E.164.
  const lead = await findLeadByPhone(phone);
  const category: SupportCategory = lead ? "meta_or_lead" : "customer_support";

  // ignoreDuplicates is load-bearing, not incidental: composing into a thread
  // that already exists must be purely additive, never clobbering its category,
  // needs_review, assigned_to or classifier_output. So this is insert-if-absent,
  // never an update. Rows come back only when we inserted — that's isNew (the
  // same idiom as the message insert in step 2).
  const { data: inserted, error } = await supabase
    .from("support_conversations")
    .upsert(
      {
        blooio_chat_id: phone,
        phone,
        contact_name: contactName,
        category,
        status: "open",
        needs_review: false,
        linked_lead_id: lead?.id ?? null,
        assigned_to: createdBy,
        classifier_output: {
          category,
          confidence: "high",
          reason: lead
            ? "Operator-composed outbound to a phone already in the lead funnel."
            : "Operator-composed outbound — no inbound message to classify.",
          source: "operator_compose",
          createdBy
        }
      },
      { onConflict: "blooio_chat_id", ignoreDuplicates: true }
    )
    .select("*");
  if (error) throw new Error(error.message);

  const insertedRow = (inserted ?? [])[0];
  if (insertedRow) {
    return { conversation: normalizeConversation(insertedRow as ConversationRow), isNew: true };
  }

  const existing = await getConversationByChatId(phone);
  if (!existing) throw new Error(`support_conversations row missing after upsert for ${phone}`);

  // Fill a BLANK name from what the operator typed. The insert above couldn't
  // (ignoreDuplicates), and recordOutboundMessage can't either — it passes
  // contactName: null — so without this the typed name is silently dropped and
  // the thread keeps showing a bare phone number. Filling a null is additive,
  // not the clobber ignoreDuplicates exists to prevent; same rule (and same
  // `&& !convo.contactName` guard) as touchConversationActivity.
  if (contactName && !existing.contactName) {
    const { error: nameErr } = await supabase
      .from("support_conversations")
      .update({ contact_name: contactName })
      .eq("id", existing.id)
      .is("contact_name", null);
    if (nameErr) throw new Error(nameErr.message);
    return { conversation: { ...existing, contactName }, isNew: false };
  }
  return { conversation: existing, isNew: false };
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
