import "server-only";
import {
  transitionLead, recordEvent, getLeadById,
  cancelAllPending, cancelMessagesByKind,
  scheduleRecoveryDrip, scheduleEngagementDrip,
  type OutboundLead, type MessageKind
} from "@/lib/outbound-leads";
import { manualTransitionTargets, type LeadStatus } from "@/lib/outbound-stages";
import { FLOW_KINDS, canMoveToSequence, type FlowKey } from "@/lib/outbound-flow-config";
import {
  notifyMarkedNoShow, notifyMarkedSold, notifyMarkedLost, notifyMarkedContract
} from "@/lib/outbound-slack";

// Manual, rep-driven stage transitions — the single orchestration point
// behind BOTH the kanban board (POST .../transition) and the detail-page
// action buttons (the mark-* routes delegate here). Wraps the pure
// state-machine write (transitionLead) with the per-destination side effects
// each manual mark performs: stamping timestamps, cancelling now-moot
// scheduled SMS, kicking off the engagement drip, and the Slack ping.
//
// Booking (→ booked) is Calendly-only and rejected here (it isn't a manual
// target). Validity is checked against MANUAL_TRANSITIONS first, then
// transitionLead re-checks the full state machine before writing.

export interface ManualTransitionResult {
  lead: OutboundLead;
  // Engagement-drip messages scheduled by this move (no_show only).
  scheduled: number;
  // Pending SMS canceled by this move.
  canceled: number;
}

export async function applyManualTransition(
  leadId: string,
  to: LeadStatus,
  opts: { by: string; notes?: string | null }
): Promise<ManualTransitionResult> {
  const lead = await getLeadById(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);
  if (!manualTransitionTargets(lead.status).includes(to)) {
    throw new Error(`Can't move a "${lead.status}" lead to "${to}"`);
  }

  switch (to) {
    case "showed": {
      const updated = await transitionLead(leadId, "showed");
      await recordEvent(leadId, "marked_showed", { by: opts.by });
      return { lead: updated, scheduled: 0, canceled: 0 };
    }
    case "no_show": {
      const updated = await transitionLead(leadId, "no_show", {
        no_show_at: new Date().toISOString()
      });
      await recordEvent(leadId, "marked_no_show", { by: opts.by });
      // Reminders that haven't fired yet are now moot.
      const canceled = await cancelMessagesByKind(leadId, [
        "reminder_24h", "reminder_1h", "confirmation"
      ]);
      const scheduled = await scheduleEngagementDrip(updated);
      await notifyMarkedNoShow(updated);
      return { lead: updated, scheduled, canceled };
    }
    case "contract": {
      // Contract sits between Showed and Won — no drip side effects, just the
      // move + a heads-up so the team knows paperwork is out for signature.
      const updated = await transitionLead(leadId, "contract");
      await notifyMarkedContract(updated);
      return { lead: updated, scheduled: 0, canceled: 0 };
    }
    case "success": {
      const notes = opts.notes?.trim() || null;
      const updated = await transitionLead(leadId, "success", {
        sold_at: new Date().toISOString(),
        sold_notes: notes
      });
      await recordEvent(leadId, "marked_sold", { by: opts.by, notes });
      const canceled = await cancelAllPending(leadId);
      await notifyMarkedSold({ lead: updated, notes });
      return { lead: updated, scheduled: 0, canceled };
    }
    case "lost": {
      const updated = await transitionLead(leadId, "lost", {
        marked_lost_at: new Date().toISOString()
      });
      await recordEvent(leadId, "marked_lost", { by: opts.by });
      const canceled = await cancelAllPending(leadId);
      await notifyMarkedLost(updated);
      return { lead: updated, scheduled: 0, canceled };
    }
    case "warm_lead": {
      // Resurrect-from-lost. No drips re-armed automatically — a rep
      // re-engages by hand or the lead re-submits the form.
      const updated = await transitionLead(leadId, "warm_lead");
      return { lead: updated, scheduled: 0, canceled: 0 };
    }
    default:
      throw new Error(`Unsupported manual transition target: ${to}`);
  }
}

// ---- SEQUENCE MOVES (Flow board) ----

const ALL_SEQUENCE_KINDS: MessageKind[] = [
  "confirmation", "reminder_24h", "reminder_1h", "recovery_drip", "engagement_drip"
];

export interface SequenceMoveResult {
  lead: OutboundLead;
  scheduled: number;  // messages scheduled for the target drip (5)
  canceled: number;   // pending messages canceled from the prior sequence
}

// Move a lead's active SMS nurture sequence (Flow board drag). Cancels every
// pending sequence message that isn't the target's kind, then schedules the
// target drip. Booking is not a valid manual target (Calendly-only). Does NOT
// touch the lead's pipeline status — this only swaps which drip they receive.
export async function moveLeadToSequence(
  leadId: string,
  to: FlowKey,
  opts: { by: string }
): Promise<SequenceMoveResult> {
  if (!canMoveToSequence(to)) {
    throw new Error(
      to === "booking"
        ? "Booking is set when a Calendly meeting is booked"
        : `Can't move a lead into the "${to}" sequence`
    );
  }
  const lead = await getLeadById(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);

  const keep = new Set<MessageKind>(FLOW_KINDS[to]);
  const canceled = await cancelMessagesByKind(
    leadId,
    ALL_SEQUENCE_KINDS.filter((k) => !keep.has(k))
  );
  const scheduled = to === "recovery"
    ? await scheduleRecoveryDrip(lead)
    : await scheduleEngagementDrip(lead);

  await recordEvent(leadId, "sequence_changed", { to, by: opts.by });
  return { lead, scheduled, canceled };
}
