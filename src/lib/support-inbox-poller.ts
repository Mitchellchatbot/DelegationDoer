import "server-only";
import { listBlooioChats, getBlooioChatMessages } from "@/lib/blooio";
import {
  ingestInboundMessage, reconcileUnlinkedLeadConversations
} from "@/lib/support-intake";

// Polling backstop for the customer-support inbox. The real-time Blooio webhook
// is primary; this cron sweeps the Blooio API every minute to catch anything a
// missed/failed webhook delivery dropped. Idempotent against the webhook via
// the support_messages.blooio_message_id UNIQUE constraint, so re-ingesting an
// already-seen message is a cheap no-op.
//
// The scan horizon is a FIXED wall-clock window anchored to now() — it is NOT
// derived from any DB column. (An earlier design read max(last_inbound_at),
// which the webhook advances in real time; that let the horizon march past any
// message the webhook missed, so the backstop could permanently skip exactly
// the drops it exists to catch.) With a fixed window, every dropped inbound
// within the window is re-offered on the next sweep and deduped on insert, so
// nothing is silently lost as long as the poller runs at least once within the
// window of a drop. ingest only classifies the FIRST inbound of an
// un-categorized conversation, so re-scans of already-categorized chats cost
// one Blooio fetch, not an LLM call.

const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
// Generous recovery window for a webhook outage while bounding fan-out. A drop
// is recoverable for this long after it arrives (the webhook is primary, so the
// poller normally re-offers it within a minute anyway).
const POLL_LOOKBACK_MS = 24 * HOUR;
// Safety cap on per-run chat fan-out (each scanned chat costs one Blooio
// message fetch). Deferred chats are picked up on the next minute's tick.
const MAX_CHATS_PER_RUN = 300;
// Cap the LLM classify calls one sweep can make, so a backlog of brand-new
// conversations (first run after go-live, or a long webhook outage) cannot
// spike Anthropic spend in a single tick — the remainder classifies later.
const MAX_CLASSIFY_PER_RUN = 50;

export interface SupportPollResult {
  scanned: number;    // chats whose messages we fetched
  ingested: number;   // new (non-duplicate) inbound messages persisted
  classified: number; // conversations classified + routed this run
  reconciled: number; // half-routed lead conversations re-linked this run
}

export async function runSupportInboxPoll(): Promise<SupportPollResult> {
  const watermarkMs = Date.now() - POLL_LOOKBACK_MS;
  const chats = await listBlooioChats(); // sorted by lastMessageTime desc

  let scanned = 0;
  let ingested = 0;
  let classified = 0;

  for (const chat of chats) {
    if (scanned >= MAX_CHATS_PER_RUN) {
      console.warn("[support-poll] hit MAX_CHATS_PER_RUN cap — older chats deferred to next run");
      break;
    }
    if (classified >= MAX_CLASSIFY_PER_RUN) {
      console.warn("[support-poll] hit MAX_CLASSIFY_PER_RUN cap — remaining new conversations deferred to next run");
      break;
    }
    // The list is sorted by lastMessageTime (any direction) desc. Since a chat's
    // last inbound is always <= its last message, once lastMessageTime predates
    // the window every remaining chat does too — safe to BREAK.
    const lastMsgMs = chat.lastMessageTime ? new Date(chat.lastMessageTime).getTime() : 0;
    if (lastMsgMs && lastMsgMs < watermarkMs) break;
    // Within the in-window chats, skip ones whose newest INBOUND predates the
    // window (e.g. a chat kept "recent" only by our own outbound replies) — they
    // have no inbound to recover, so scanning them is wasted Blooio fetches.
    const lastInMs = chat.lastInboundTime ? new Date(chat.lastInboundTime).getTime() : 0;
    if (!lastInMs || lastInMs < watermarkMs) continue;

    scanned++;
    const messages = await getBlooioChatMessages(chat.id); // oldest first
    for (const m of messages) {
      if (m.direction !== "inbound") continue;
      const sentMs = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      if (sentMs && sentMs < watermarkMs) continue;
      try {
        const res = await ingestInboundMessage({
          chatId: chat.id,
          phone: m.externalId ?? chat.contactNumber ?? chat.id,
          contactName: chat.contactName,
          blooioMessageId: m.id,
          body: m.text,
          sentAt: m.createdAt || new Date().toISOString(),
          direction: "inbound"
        });
        if (res.outcome !== "duplicate") ingested++;
        if (res.outcome === "classified") classified++;
      } catch (err) {
        // One bad message must not abort the whole sweep.
        console.error("[support-poll] ingest failed", {
          chatId: chat.id,
          messageId: m.id,
          error: err instanceof Error ? err.message : err
        });
      }
    }
  }

  // Re-link any conversation that classified as a lead but lost its lead link to
  // a transient error after the category flip. Cheap, idempotent, bounded.
  let reconciled = 0;
  try {
    reconciled = await reconcileUnlinkedLeadConversations();
  } catch (err) {
    console.error("[support-poll] reconcile failed", {
      error: err instanceof Error ? err.message : err
    });
  }

  return { scanned, ingested, classified, reconciled };
}
