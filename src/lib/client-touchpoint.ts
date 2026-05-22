// Touchpoint health — traffic-light view of how recently we've sent an
// outbound email to each client. Distinct from the sentiment-based
// `health_label` in client-health.ts; this one is purely about cadence.
//
// Bands (per Task 2 spec):
//   green  -> last outbound email within the last 3 days
//   yellow -> 3 < days <= 10
//   red    -> more than 10 days, or no outbound email on record
//
// Data source for "auto" reading is the email_drafts table — every
// outbound email composed inside DelegationDoer lands there with
// status='sent' once missiveclone confirms delivery. Email sent
// straight from Missive without going through DD won't show up here;
// that's an accepted limitation since the team is moving all outbound
// through the approval queue anyway.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type TouchpointLabel = "green" | "yellow" | "red";

export const TOUCHPOINT_META: Record<TouchpointLabel, {
  label: string;
  description: string;
  // Tailwind tone tokens used by the pill/badge.
  bg: string; text: string; border: string; dot: string;
  // Solid background variant for dashboard tiles where contrast matters.
  solidBg: string; solidText: string;
}> = {
  green: {
    label: "Healthy",
    description: "Emailed within the last 3 days.",
    bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-500",
    solidBg: "bg-emerald-500", solidText: "text-white"
  },
  yellow: {
    label: "Stale",
    description: "No outbound email in 3+ days — getting cold.",
    bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", dot: "bg-amber-500",
    solidBg: "bg-amber-500", solidText: "text-white"
  },
  red: {
    label: "Neglected",
    description: "No outbound email in 10+ days — needs follow-up.",
    bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", dot: "bg-rose-500",
    solidBg: "bg-rose-500", solidText: "text-white"
  }
};

// Pure function — returns the auto band from a "last sent at" date.
// Used both by the server query helper (when building per-client
// payloads) and by the dashboard summarizers.
export function computeTouchpointLabel(lastSentAt: string | null, now: Date = new Date()): TouchpointLabel {
  if (!lastSentAt) return "red";
  const last = new Date(lastSentAt).getTime();
  if (Number.isNaN(last)) return "red";
  const days = (now.getTime() - last) / 86_400_000;
  if (days <= 3) return "green";
  if (days <= 10) return "yellow";
  return "red";
}

export function daysSince(lastSentAt: string | null, now: Date = new Date()): number | null {
  if (!lastSentAt) return null;
  const last = new Date(lastSentAt).getTime();
  if (Number.isNaN(last)) return null;
  return Math.max(0, Math.floor((now.getTime() - last) / 86_400_000));
}

// Resolves what the UI should display: leader override wins, otherwise
// the auto band derived from the last outbound email.
export function effectiveTouchpoint(
  override: TouchpointLabel | null,
  lastSentAt: string | null
): { label: TouchpointLabel; isOverride: boolean } {
  if (override) return { label: override, isOverride: true };
  return { label: computeTouchpointLabel(lastSentAt), isOverride: false };
}

export interface TouchpointInfo {
  clientId: string;
  lastOutboundEmailAt: string | null;
  lastOutboundSubject: string | null;
}

// Single round-trip: pulls the MAX(sent_at) per client_id from
// email_drafts, plus the subject of that latest send. Returns a map
// keyed by client_id so callers can decorate a list of clients
// without N+1ing the database.
//
// Only counts status='sent' rows — drafts/approved-but-not-yet-sent
// don't count toward "we touched the client" by design.
export async function getLatestTouchpointsByClient(
  clientIds: string[]
): Promise<Map<string, TouchpointInfo>> {
  const out = new Map<string, TouchpointInfo>();
  if (clientIds.length === 0) return out;

  const supabase = getSupabaseAdmin();
  // Pull every sent row scoped to the requested clients, sorted newest
  // first. We then walk once and keep the first row per client_id.
  // For a workspace with ~hundreds of sent emails this is a cheaper
  // query than per-client MAX subqueries.
  const { data, error } = await supabase
    .from("email_drafts")
    .select("client_id, subject, sent_at")
    .eq("status", "sent")
    .not("sent_at", "is", null)
    .in("client_id", clientIds)
    .order("sent_at", { ascending: false })
    .limit(2000);

  if (error) return out;
  for (const row of (data ?? []) as { client_id: string | null; subject: string | null; sent_at: string | null }[]) {
    if (!row.client_id || !row.sent_at) continue;
    if (out.has(row.client_id)) continue; // already have the latest
    out.set(row.client_id, {
      clientId: row.client_id,
      lastOutboundEmailAt: row.sent_at,
      lastOutboundSubject: row.subject ?? null
    });
  }
  return out;
}

// Snake-case row → camel-case shape for the touchpoint override fields.
export interface TouchpointOverrideRow {
  touchpoint_override_label: TouchpointLabel | null;
  touchpoint_override_note: string | null;
  touchpoint_override_by: string | null;
  touchpoint_override_at: string | null;
  touchpoint_summary: string | null;
  touchpoint_summary_at: string | null;
  touchpoint_summary_by: string | null;
}

export interface TouchpointFields {
  touchpointOverrideLabel: TouchpointLabel | null;
  touchpointOverrideNote: string | null;
  touchpointOverrideBy: string | null;
  touchpointOverrideAt: string | null;
  touchpointSummary: string | null;
  touchpointSummaryAt: string | null;
  touchpointSummaryBy: string | null;
}

export function rowToTouchpointFields(r: TouchpointOverrideRow): TouchpointFields {
  return {
    touchpointOverrideLabel: r.touchpoint_override_label,
    touchpointOverrideNote: r.touchpoint_override_note,
    touchpointOverrideBy: r.touchpoint_override_by,
    touchpointOverrideAt: r.touchpoint_override_at,
    touchpointSummary: r.touchpoint_summary,
    touchpointSummaryAt: r.touchpoint_summary_at,
    touchpointSummaryBy: r.touchpoint_summary_by
  };
}
