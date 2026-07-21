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
// outbound email composed inside Scaled Operations lands there with
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
  // Was rose / red — recolored to slate / grey because the leader was
  // anxious looking at a wall of red dots every morning. "Shaky" reads
  // as a status that needs a nudge without feeling like an emergency.
  // The downstream solidBg / solidText tokens stay for callers that
  // really do want an alarming surface.
  red: {
    label: "Shaky",
    description: "No outbound email in 10+ days — could use a touch.",
    bg: "bg-slate-100", text: "text-slate-700", border: "border-slate-300", dot: "bg-slate-400",
    solidBg: "bg-slate-500", solidText: "text-white"
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

// Automated outbound emails that must NOT count as a client touchpoint.
// These are bulk/templated updates the team sends on a schedule (e.g.
// the weekly blog-performance mailers "Your Blog Posts Are Getting More
// Visibility This Month" / "Your Blog's Getting More Traffic Now"). They
// go out from a normal team address, so the only reliable tell is the
// templated subject — mirroring the subject-pattern approach in
// email-intake-filters.ts (`looksAutomated`). Keep this list focused;
// it's easy to extend as new templates appear.
//
// Applied in two places:
//   - touchpoint-sync.ts, when walking the SENT folder, so the stored
//     `last_outbound_email_at_external` reflects the freshest *real*
//     email rather than an automated blast.
//   - getLatestTouchpointsByClient below, as a read-time safety net so
//     already-synced automated values (and any DD-originated drafts)
//     are ignored immediately, without waiting for the next sync.
const AUTOMATED_OUTBOUND_SUBJECT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Weekly blog-performance updates. Both observed templates open with
  // "Your Blog" and tout a growth metric (visibility / traffic / views).
  {
    re: /^your\s+blog('?s)?\b.*\b(visibilit(y|ies)|traffic|views?|reach|exposure|impressions?|ranking|getting\s+more|more\s+(visibility|traffic|views?|reach))\b/i,
    label: "weekly blog performance update"
  }
  // NOTE: the monthly SEO-update blast (/clients/bulk-email) is NOT matched by
  // subject — its subject is worker-authored. It's excluded from touchpoint via
  // an explicit per-message marker (messages.is_automated on the clone, surfaced
  // as MissiveThread.automated and skipped in touchpoint-sync.ts).
];

// True when a subject looks like one of our automated outbound blasts
// (so it shouldn't register as a real touchpoint with the client).
export function isAutomatedOutboundSubject(subject: string | null): boolean {
  const s = (subject ?? "").trim();
  if (!s) return false;
  return AUTOMATED_OUTBOUND_SUBJECT_PATTERNS.some((p) => p.re.test(s));
}

export interface TouchpointInfo {
  clientId: string;
  lastOutboundEmailAt: string | null;
  lastOutboundSubject: string | null;
}

// Two-source lookup: pulls the MAX(sent_at) per client from
// email_drafts (mail composed inside Scaled Operations) AND the synced
// `last_outbound_email_at_external` column on clients (populated by
// lib/touchpoint-sync.ts from missiveclone's SENT folder). Returns
// the *more recent* of the two so the dashboard reflects "last email
// we sent this client" regardless of which surface it went out from.
//
// Only counts email_drafts status='sent' rows — drafts/approved-
// but-not-yet-sent don't count toward "we touched the client".
export async function getLatestTouchpointsByClient(
  clientIds: string[]
): Promise<Map<string, TouchpointInfo>> {
  const out = new Map<string, TouchpointInfo>();
  if (clientIds.length === 0) return out;

  const supabase = getSupabaseAdmin();
  // Round 1: Scaled Operations-originated sends.
  const draftsP = supabase
    .from("email_drafts")
    .select("client_id, subject, sent_at")
    .eq("status", "sent")
    .not("sent_at", "is", null)
    .in("client_id", clientIds)
    .order("sent_at", { ascending: false })
    .limit(2000);

  // Round 2: missiveclone-synced sends. Read the denormalized column
  // off `clients` so the dashboard query is one extra trip total, not
  // per-client.
  const externalP = supabase
    .from("clients")
    .select("id, last_outbound_email_at_external, last_outbound_subject_external")
    .in("id", clientIds);

  const [draftsRes, externalRes] = await Promise.all([draftsP, externalP]);

  if (!draftsRes.error) {
    for (const row of (draftsRes.data ?? []) as {
      client_id: string | null; subject: string | null; sent_at: string | null;
    }[]) {
      if (!row.client_id || !row.sent_at) continue;
      // Automated blasts (weekly blog updates, etc.) don't count as a
      // touchpoint — skip and let an older real email win.
      if (isAutomatedOutboundSubject(row.subject)) continue;
      const prev = out.get(row.client_id);
      // email_drafts comes back DESC, so the first hit per client is
      // already the latest from that source. Skip subsequent rows.
      if (prev?.lastOutboundEmailAt) continue;
      out.set(row.client_id, {
        clientId: row.client_id,
        lastOutboundEmailAt: row.sent_at,
        lastOutboundSubject: row.subject ?? null
      });
    }
  }

  if (!externalRes.error) {
    for (const row of (externalRes.data ?? []) as {
      id: string;
      last_outbound_email_at_external: string | null;
      last_outbound_subject_external: string | null;
    }[]) {
      if (!row.last_outbound_email_at_external) continue;
      // The external column is denormalized to a single subject+date. If
      // that stored email is an automated blast, ignore it — this lets
      // the fix take effect immediately, before the next SENT-folder sync
      // re-stores the freshest *real* email.
      if (isAutomatedOutboundSubject(row.last_outbound_subject_external)) continue;
      const prev = out.get(row.id);
      const extMs = new Date(row.last_outbound_email_at_external).getTime();
      const prevMs = prev?.lastOutboundEmailAt
        ? new Date(prev.lastOutboundEmailAt).getTime()
        : -Infinity;
      if (extMs > prevMs) {
        out.set(row.id, {
          clientId: row.id,
          lastOutboundEmailAt: row.last_outbound_email_at_external,
          lastOutboundSubject: row.last_outbound_subject_external ?? prev?.lastOutboundSubject ?? null
        });
      }
    }
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
