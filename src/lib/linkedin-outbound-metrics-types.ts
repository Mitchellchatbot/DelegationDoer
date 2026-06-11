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

// Per-day activity row from outbound.daily. The upstream window is
// 30 days; we render it as a sparkline grid keyed on `date`.
export interface OutboundDailyPoint {
  date: string;     // YYYY-MM-DD
  messages: number;
  likes: number;
  comments: number;
}

// Pre-computed funnel from the upstream service. `count` is
// CUMULATIVE — how many leads have ever entered this stage — so it's
// distinct from leads_by_status, which is a current-bucket snapshot.
// `conversion` is a percentage (0-100), not a 0-1 rate, and is null
// for the head of the funnel (discovered).
export interface FunnelEntry {
  stage: FunnelStage;
  label: string;
  count: number;
  conversion: number | null;
}

// Pipeline funnel buckets — snapshot of where each lead currently
// sits. discovered → invited → accepted → messaged → replied → booked
// is the natural progression; dead and re_enrolled are terminal
// states that pull *from* the funnel rather than continuing it.
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
  generatedAt: string | null;
  periodDays: number | null;
  engagement: EngagementTotals;
  daily: OutboundDailyPoint[];
  funnel: FunnelEntry[];
  leads_by_status: LeadsByStatus;
  leads: LeadsTotals;
}

export type LinkedInOutboundResult =
  | { ok: true; data: LinkedInOutboundMetrics }
  | { ok: false; error: string };

// Funnel + terminal status definitions. Single source of truth so
// every widget agrees on ordering and labels.
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
