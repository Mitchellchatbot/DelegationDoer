// Client-safe types + constants for the LinkedIn outbound dashboard.
// The fetcher lives in linkedin-outbound-metrics.ts which is marked
// `server-only` (it holds the tokenized KPIs URL). Splitting the pure
// types out into their own file lets the dashboard's "use client"
// content component import them without dragging the server-only
// directive into the client bundle.

// Engagement-side: outbound activity counters from the LinkedIn
// automation runner. `replied` here is "how many replies arrived to
// our DMs" — different from the lead-side `replied` status (which is
// a per-lead bucket). They typically agree but we don't assume it.
export interface EngagementTotals {
  dms_sent: number;
  likes: number;
  comments: number;
  replied: number;
}

// Pipeline funnel buckets. Order matches the natural progression:
// discovered → invited → accepted → messaged → replied → booked.
// `dead` and `re_enrolled` are terminal states that pull from the
// funnel rather than continuing it.
export interface LeadsByStatus {
  discovered: number;
  invited: number;
  accepted: number;
  messaged: number;
  replied: number;
  booked: number;
  dead: number;
  re_enrolled: number;
}

export interface LeadsTotals {
  total_leads: number;
  active_in_pipeline: number;
}

export interface LinkedInOutboundMetrics {
  engagement: EngagementTotals;
  leads_by_status: LeadsByStatus;
  leads: LeadsTotals;
}

export type LinkedInOutboundResult =
  | { ok: true; data: LinkedInOutboundMetrics }
  | { ok: false; error: string };

// Funnel + terminal status definitions. Single source of truth so the
// hero row, funnel widget, and terminal tiles all agree on ordering
// and labels.
export type FunnelStage =
  | "discovered" | "invited" | "accepted" | "messaged" | "replied" | "booked";

export const FUNNEL_STAGES: FunnelStage[] = [
  "discovered", "invited", "accepted", "messaged", "replied", "booked"
];

export const STAGE_LABEL: Record<keyof LeadsByStatus, string> = {
  discovered: "Discovered",
  invited: "Invited",
  accepted: "Accepted",
  messaged: "Messaged",
  replied: "Replied",
  booked: "Booked",
  dead: "Dead",
  re_enrolled: "Re-enrolled"
};

export const STAGE_HINT: Record<keyof LeadsByStatus, string> = {
  discovered: "Sourced into the pipeline, not yet contacted.",
  invited: "Connection request sent.",
  accepted: "Connection request accepted.",
  messaged: "First DM sent.",
  replied: "Lead replied to one of our DMs.",
  booked: "Meeting on the calendar.",
  dead: "Removed from the active funnel (no-reply or opt-out).",
  re_enrolled: "Pulled back into the pipeline after a previous exit."
};
