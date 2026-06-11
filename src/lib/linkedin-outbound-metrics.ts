import "server-only";

import type {
  LinkedInOutboundMetrics, LinkedInOutboundResult,
  EngagementTotals, LeadsByStatus, LeadsTotals
} from "./linkedin-outbound-metrics-types";

// LinkedIn outbound dashboard data source.
//
// Calls a tokenized KPIs endpoint on the standalone LinkedIn outbound
// automation service (deployed at scaledai.netlify.app). The "secret"
// is baked into the URL path, so the full URL is held in
// LINKEDIN_OUTBOUND_KPIS_URL and treated as a credential — server-only
// import keeps it out of the client bundle.
//
// Response shape is forgiving: the upstream service has shipped two
// flavors (a flat layout where `totals` means engagement totals, and a
// nested layout with explicit `engagement` / `leads` blocks). The
// parser below tries both so a schema flip on the LinkedIn service
// doesn't break this dashboard.

export async function getLinkedInOutboundMetrics(): Promise<LinkedInOutboundResult> {
  const url = process.env.LINKEDIN_OUTBOUND_KPIS_URL?.trim();
  if (!url) {
    return { ok: false, error: "Missing LINKEDIN_OUTBOUND_KPIS_URL" };
  }

  let res: Response;
  try {
    // Short 2-min cache — KPIs here move slowly (LinkedIn auto-actions
    // are rate-limited to a few dozen/day) but operators do refresh
    // the page expecting fresh-ish numbers after a campaign push.
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: 120 }
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }

  // The Netlify gate redirects HTML when unauth'd; surface that
  // clearly so the empty state can hint at the right fix instead of
  // emitting a confusing JSON parse error.
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("json")) {
    return {
      ok: false,
      error: `Endpoint returned ${ct || "non-JSON"} (HTTP ${res.status}) — Netlify may have redirected to login`
    };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `Non-JSON response (${res.status})` };
  }
  if (!res.ok) {
    const msg = (json as { message?: string; error?: string }).message
      ?? (json as { error?: string }).error
      ?? `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }

  const parsed = parseMetrics(json);
  if (!parsed) {
    return { ok: false, error: "Unexpected response shape (no recognizable totals or leads_by_status)" };
  }
  return { ok: true, data: parsed };
}

// Defensive parser. Handles all of:
//   { engagement: { totals: {...} }, leads: { leads_by_status: {...}, totals: {...} } }
//   { totals: { dms_sent, ... }, leads_by_status: {...}, leads_totals: {...} }
//   { totals: { dms_sent, ... }, leads_by_status: {...}, totals: { total_leads, ... } } *
//
// (*) JSON can't really have two top-level `totals` keys, but if the
// upstream is constructed by string-concat anywhere we'd see whichever
// one was emitted last. The cascade below picks the most informative
// available value rather than relying on a single field name.
function parseMetrics(raw: unknown): LinkedInOutboundMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const engagement = extractEngagement(r);
  const leads_by_status = extractLeadsByStatus(r);
  const leads = extractLeadsTotals(r);

  if (!engagement && !leads_by_status && !leads) return null;

  return {
    engagement: engagement ?? { dms_sent: 0, likes: 0, comments: 0, replied: 0 },
    leads_by_status: leads_by_status ?? {
      discovered: 0, invited: 0, accepted: 0, messaged: 0,
      replied: 0, booked: 0, dead: 0, re_enrolled: 0
    },
    leads: leads ?? { total_leads: 0, active_in_pipeline: 0 }
  };
}

function extractEngagement(r: Record<string, unknown>): EngagementTotals | null {
  // 1. Nested: r.engagement.totals
  const nested = (r.engagement as { totals?: unknown } | undefined)?.totals;
  if (looksLikeEngagement(nested)) return coerceEngagement(nested as Record<string, unknown>);
  // 2. Flat: r.totals (only if it has engagement-shaped keys)
  if (looksLikeEngagement(r.totals)) return coerceEngagement(r.totals as Record<string, unknown>);
  return null;
}

function extractLeadsByStatus(r: Record<string, unknown>): LeadsByStatus | null {
  // 1. Nested
  const nested = (r.leads as { leads_by_status?: unknown } | undefined)?.leads_by_status;
  if (looksLikeLeadsByStatus(nested)) return coerceLeadsByStatus(nested as Record<string, unknown>);
  // 2. Flat
  if (looksLikeLeadsByStatus(r.leads_by_status)) {
    return coerceLeadsByStatus(r.leads_by_status as Record<string, unknown>);
  }
  return null;
}

function extractLeadsTotals(r: Record<string, unknown>): LeadsTotals | null {
  // 1. Nested: r.leads.totals
  const nested = (r.leads as { totals?: unknown } | undefined)?.totals;
  if (looksLikeLeadsTotals(nested)) return coerceLeadsTotals(nested as Record<string, unknown>);
  // 2. Flat with explicit name
  if (looksLikeLeadsTotals(r.leads_totals)) return coerceLeadsTotals(r.leads_totals as Record<string, unknown>);
  // 3. Last resort: r.totals if it's shaped like leads totals (the
  //    engagement-totals path above would have already claimed it
  //    otherwise, so the two shapes are mutually exclusive in
  //    practice).
  if (looksLikeLeadsTotals(r.totals)) return coerceLeadsTotals(r.totals as Record<string, unknown>);
  return null;
}

function looksLikeEngagement(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return "dms_sent" in (v as Record<string, unknown>) || "likes" in (v as Record<string, unknown>);
}
function looksLikeLeadsByStatus(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return "discovered" in (v as Record<string, unknown>) || "messaged" in (v as Record<string, unknown>);
}
function looksLikeLeadsTotals(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return "total_leads" in (v as Record<string, unknown>) || "active_in_pipeline" in (v as Record<string, unknown>);
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function coerceEngagement(o: Record<string, unknown>): EngagementTotals {
  return {
    dms_sent: num(o, "dms_sent"),
    likes: num(o, "likes"),
    comments: num(o, "comments"),
    replied: num(o, "replied")
  };
}
function coerceLeadsByStatus(o: Record<string, unknown>): LeadsByStatus {
  return {
    discovered: num(o, "discovered"),
    invited: num(o, "invited"),
    accepted: num(o, "accepted"),
    messaged: num(o, "messaged"),
    replied: num(o, "replied"),
    booked: num(o, "booked"),
    dead: num(o, "dead"),
    re_enrolled: num(o, "re_enrolled")
  };
}
function coerceLeadsTotals(o: Record<string, unknown>): LeadsTotals {
  return {
    total_leads: num(o, "total_leads"),
    active_in_pipeline: num(o, "active_in_pipeline")
  };
}
