// Client-safe configuration for the SMS-sequence ("flow") board on the Flows
// tab. Deliberately FREE of server-only imports so the server move-helper
// (lib/outbound-transitions.ts) and the client kanban (OutboundSequenceBoard)
// share one source of truth — especially the kind <-> flow mapping, which must
// not drift between where a lead's flow is *derived* and where it's *moved*.

import type { MessageKind } from "@/lib/outbound-leads";

export type FlowKey = "booking" | "recovery" | "engagement";

// Which scheduled-message kinds belong to each flow. A lead's active flow is
// derived from the kinds of its PENDING outbound_scheduled_messages.
export const FLOW_KINDS: Record<FlowKey, MessageKind[]> = {
  booking:    ["confirmation", "reminder_24h", "reminder_1h"],
  recovery:   ["recovery_drip"],
  engagement: ["engagement_drip"]
};

// Reverse lookup: message kind -> flow.
export function kindToFlow(kind: MessageKind): FlowKey | null {
  if (FLOW_KINDS.booking.includes(kind)) return "booking";
  if (FLOW_KINDS.recovery.includes(kind)) return "recovery";
  if (FLOW_KINDS.engagement.includes(kind)) return "engagement";
  return null;
}

// The flows a rep can move a lead INTO by hand. Booking is excluded — a lead
// only enters Booking via a Calendly meeting (scheduleBookingMessages needs a
// meeting time), so dragging a card into the Booking column is rejected. (You
// can still drag a lead OUT of Booking into a drip.)
export const MANUAL_SEQUENCE_TARGETS: FlowKey[] = ["recovery", "engagement"];
export function canMoveToSequence(to: FlowKey): boolean {
  return MANUAL_SEQUENCE_TARGETS.includes(to);
}

// Left-to-right column order on the flow board.
export const SEQUENCE_BOARD_ORDER: FlowKey[] = ["booking", "recovery", "engagement"];

export interface FlowMeta {
  label: string;
  description: string;
  pill: string;       // small badge classes
  ring: string;       // column border tint
  countBg: string;
  countText: string;
  emptyHint: string;
}

export const FLOW_META: Record<FlowKey, FlowMeta> = {
  booking: {
    label: "Booking sequence",
    description: "Confirmation + 24h & 1h reminders around the meeting.",
    pill: "bg-sky-50 text-sky-700 border-sky-200/60",
    ring: "border-sky-200/70", countBg: "bg-sky-100", countText: "text-sky-700",
    emptyHint: "No meetings booked."
  },
  recovery: {
    label: "Recovery drip",
    description: "5 nudges over 30 days for warm leads who haven't booked.",
    pill: "bg-amber-50 text-amber-700 border-amber-200/60",
    ring: "border-amber-200/70", countBg: "bg-amber-100", countText: "text-amber-700",
    emptyHint: "No warm leads being nudged."
  },
  engagement: {
    label: "Engagement drip",
    description: "5 nudges over 30 days to re-engage no-shows.",
    pill: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/60",
    ring: "border-fuchsia-200/70", countBg: "bg-fuchsia-100", countText: "text-fuchsia-700",
    emptyHint: "No re-engagement running."
  }
};
