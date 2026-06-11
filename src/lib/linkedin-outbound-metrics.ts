import "server-only";

import type {
  LinkedInOutboundMetrics, LinkedInOutboundResult,
  EngagementTotals, LeadsByStatus, LeadsTotals,
  OutboundDailyPoint, FunnelEntry, FunnelStage
} from "./linkedin-outbound-metrics-types";
import { FUNNEL_STAGES, STAGE_LABEL } from "./linkedin-outbound-metrics-types";

// LinkedIn outbound dashboard data source.
//
// Calls a tokenized KPIs endpoint on the standalone LinkedIn outbound
// automation service (deployed at scaledai.netlify.app). The "secret"
// is baked into the URL path, so the full URL is held in
// LINKEDIN_OUTBOUND_KPIS_URL and treated as a credential — server-only
// import keeps it out of the client bundle.
//
// Schema (verified June 2026):
//   {
//     period_days, generated_at,
//     outbound: { totals: {...}, daily: [{date, messages, likes, comments}] },
//     funnel: [{stage, label, count, conversion}],
//     leads_by_status: {...},
//     totals: { total_leads, active_in_pipeline }
//   }
// The parser also keeps a flat-shape fallback so an upstream schema
// flip doesn't immediately break the dashboard.

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

function parseMetrics(raw: unknown): LinkedInOutboundMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const engagement = extractEngagement(r);
  const leads_by_status = extractLeadsByStatus(r);
  const leads = extractLeadsTotals(r);
  const daily = extractDaily(r);
  // Funnel comes from upstream if present, otherwise we synthesize one
  // from leads_by_status so the funnel widget still has something to
  // render on legacy shapes.
  const funnel = extractFunnel(r) ?? synthesizeFunnel(leads_by_status);

  if (!engagement && !leads_by_status && !leads && !daily.length && !funnel.length) {
    return null;
  }

  return {
    generatedAt: typeof r.generated_at === "string" ? r.generated_at : null,
    periodDays: typeof r.period_days === "number" ? r.period_days : null,
    engagement: engagement ?? { dms_sent: 0, likes: 0, comments: 0, replied: 0 },
    leads_by_status: leads_by_status ?? {
      discovered: 0, invited: 0, accepted: 0, messaged: 0,
      replied: 0, booked: 0, dead: 0, re_enrolled: 0
    },
    leads: leads ?? { total_leads: 0, active_in_pipeline: 0 },
    daily,
    funnel
  };
}

function extractEngagement(r: Record<string, unknown>): EngagementTotals | null {
  // 1. New shape: r.outbound.totals
  const outbound = (r.outbound as { totals?: unknown } | undefined)?.totals;
  if (looksLikeEngagement(outbound)) return coerceEngagement(outbound as Record<string, unknown>);
  // 2. Legacy nested: r.engagement.totals
  const nested = (r.engagement as { totals?: unknown } | undefined)?.totals;
  if (looksLikeEngagement(nested)) return coerceEngagement(nested as Record<string, unknown>);
  // 3. Flat: r.totals (only if it has engagement-shaped keys)
  if (looksLikeEngagement(r.totals)) return coerceEngagement(r.totals as Record<string, unknown>);
  return null;
}

function extractDaily(r: Record<string, unknown>): OutboundDailyPoint[] {
  const raw = (r.outbound as { daily?: unknown } | undefined)?.daily ?? r.daily;
  if (!Array.isArray(raw)) return [];
  const out: OutboundDailyPoint[] = [];
  for (const row of raw as Array<Record<string, unknown>>) {
    if (typeof row?.date !== "string") continue;
    out.push({
      date: row.date,
      messages: num(row, "messages"),
      likes: num(row, "likes"),
      comments: num(row, "comments")
    });
  }
  return out;
}

function extractFunnel(r: Record<string, unknown>): FunnelEntry[] | null {
  const raw = r.funnel;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: FunnelEntry[] = [];
  for (const row of raw as Array<Record<string, unknown>>) {
    const stage = row?.stage;
    if (typeof stage !== "string" || !FUNNEL_STAGES.includes(stage as FunnelStage)) continue;
    const conv = row.conversion;
    out.push({
      stage: stage as FunnelStage,
      label: typeof row.label === "string" ? row.label : STAGE_LABEL[stage as FunnelStage],
      count: num(row, "count"),
      conversion: conv == null ? null : Number(conv)
    });
  }
  // Order by FUNNEL_STAGES so downstream rendering doesn't rely on
  // upstream array order.
  out.sort((a, b) => FUNNEL_STAGES.indexOf(a.stage) - FUNNEL_STAGES.indexOf(b.stage));
  return out.length > 0 ? out : null;
}

// Fallback: build a funnel array from the current-bucket leads_by_status
// snapshot when the upstream doesn't ship a pre-computed one.
function synthesizeFunnel(buckets: LeadsByStatus | null): FunnelEntry[] {
  if (!buckets) return [];
  return FUNNEL_STAGES.map((stage, i) => {
    const prev = i > 0 ? buckets[FUNNEL_STAGES[i - 1]] : null;
    const count = buckets[stage];
    return {
      stage,
      label: STAGE_LABEL[stage],
      count,
      conversion: prev != null && prev > 0 ? (count / prev) * 100 : null
    };
  });
}

function extractLeadsByStatus(r: Record<string, unknown>): LeadsByStatus | null {
  // 1. Flat at root — current shape
  if (looksLikeLeadsByStatus(r.leads_by_status)) {
    return coerceLeadsByStatus(r.leads_by_status as Record<string, unknown>);
  }
  // 2. Legacy nested
  const nested = (r.leads as { leads_by_status?: unknown } | undefined)?.leads_by_status;
  if (looksLikeLeadsByStatus(nested)) return coerceLeadsByStatus(nested as Record<string, unknown>);
  return null;
}

function extractLeadsTotals(r: Record<string, unknown>): LeadsTotals | null {
  // 1. Flat at root (current shape) — r.totals contains total_leads / active_in_pipeline.
  if (looksLikeLeadsTotals(r.totals)) return coerceLeadsTotals(r.totals as Record<string, unknown>);
  // 2. Legacy nested: r.leads.totals
  const nested = (r.leads as { totals?: unknown } | undefined)?.totals;
  if (looksLikeLeadsTotals(nested)) return coerceLeadsTotals(nested as Record<string, unknown>);
  // 3. Explicit alt name
  if (looksLikeLeadsTotals(r.leads_totals)) return coerceLeadsTotals(r.leads_totals as Record<string, unknown>);
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
