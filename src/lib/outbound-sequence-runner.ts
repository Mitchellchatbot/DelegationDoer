// Outbound SMS dispatcher — pulls due scheduled_messages and sends them
// via Blooio. Idempotent via the same claim-before-send pattern used by
// scheduled-emails-runner.ts: each row is flipped from 'pending' to
// 'sending' BEFORE the network call, so a duplicate cron tick (Vercel
// cron racing with the Railway bootstrap loop) can't double-send.
//
// One runner handles every kind of outbound message:
//   - confirmation, reminder_24h, reminder_1h (one-shots scheduled
//     around a Calendly booking)
//   - recovery_drip, engagement_drip (5-step sequences)
//
// Per-row work is tiny (one Blooio POST + two DB writes), but we cap the
// batch at 50 to keep p95 latency bounded if the queue spikes.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sendBlooioMessage } from "@/lib/blooio";
import { getLeadById, recordEvent, type MessageKind, type EventKind } from "@/lib/outbound-leads";
import { DRIP_OFFSETS_DAYS } from "@/lib/outbound-sms-templates";
import { notifySequenceCompleted } from "@/lib/outbound-slack";

export interface OutboundSequenceResult {
  considered: number;
  sent: number;
  failed: number;
}

const BATCH_LIMIT = 50;

// Map the message kind to the event kind we append after a successful
// send. This is the trail the dashboard timeline renders.
const SEND_EVENT_KIND: Record<MessageKind, EventKind> = {
  confirmation:    "first_text_sent",
  reminder_24h:    "reminder_24h_sent",
  reminder_1h:     "reminder_1h_sent",
  recovery_drip:   "drip_sent",
  engagement_drip: "drip_sent"
};

interface DueRow {
  id: string;
  lead_id: string;
  kind: MessageKind;
  sequence_index: number;
  body: string;
  scheduled_for: string;
}

export async function runOutboundSequences(): Promise<OutboundSequenceResult> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("outbound_scheduled_messages")
    .select("id, lead_id, kind, sequence_index, body, scheduled_for")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) throw new Error(error.message);

  const rows = (due ?? []) as DueRow[];
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      // 1. Claim the row — flip pending → sending. The WHERE on
      //    status='pending' is the optimistic lock: if another runner
      //    already grabbed this row, the row count comes back 0 and we
      //    skip without calling Blooio.
      const claim = await supabase
        .from("outbound_scheduled_messages")
        .update({ status: "sending" }, { count: "exact" })
        .eq("id", row.id)
        .eq("status", "pending");
      if (claim.error) {
        console.error("[outbound-runner] claim error", row.id, claim.error);
        failed++;
        continue;
      }
      if ((claim.count ?? 0) === 0) {
        // Someone else got it. Quietly move on.
        continue;
      }

      // 2. Look up the lead to derive the chat id (Blooio keys by contact
      //    phone). Failure here is treated as a send failure — we mark
      //    the row failed and surface the reason.
      const lead = await getLeadById(row.lead_id);
      if (!lead) {
        await supabase
          .from("outbound_scheduled_messages")
          .update({
            status: "failed",
            error: `Lead ${row.lead_id} not found at send time`
          })
          .eq("id", row.id);
        failed++;
        continue;
      }

      // 3. Send via Blooio.
      const send = await sendBlooioMessage(lead.phone, row.body);
      if (!send.ok) {
        await supabase
          .from("outbound_scheduled_messages")
          .update({ status: "failed", error: send.error })
          .eq("id", row.id);
        failed++;
        continue;
      }

      // 4. Stamp success + append the event.
      await supabase
        .from("outbound_scheduled_messages")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          blooio_message_id: send.messageId
        })
        .eq("id", row.id);
      await recordEvent(row.lead_id, SEND_EVENT_KIND[row.kind], {
        scheduled_message_id: row.id,
        kind: row.kind,
        sequence_index: row.sequence_index,
        blooio_message_id: send.messageId,
        blooio_status: send.status
      });

      // 5. If this was the LAST message of a drip (sequence_index ===
      //    DRIP_OFFSETS_DAYS.length), the lead is done with the drip
      //    without converting — record + Slack so the rep reviews
      //    manually.
      if (
        (row.kind === "recovery_drip" || row.kind === "engagement_drip") &&
        row.sequence_index === DRIP_OFFSETS_DAYS.length
      ) {
        await recordEvent(row.lead_id, "sequence_completed", {
          kind: row.kind,
          last_message_id: row.id
        });
        try {
          await notifySequenceCompleted({ lead, sequenceKind: row.kind });
        } catch (e) {
          // Slack failure must never block the runner — log + carry on.
          console.error("[outbound-runner] sequence_completed notify failed", e);
        }
      }
      sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[outbound-runner] row failed", row.id, msg);
      await supabase
        .from("outbound_scheduled_messages")
        .update({ status: "failed", error: msg })
        .eq("id", row.id);
      failed++;
    }
  }

  return { considered: rows.length, sent, failed };
}
