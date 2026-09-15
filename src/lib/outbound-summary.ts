import "server-only";

import type { OutboundSummaryResponse, OutboundSummaryResult } from "./outbound-summary-types";

// Outbound acquisition numbers for the owner-only Scale Room and Growth Brain.
//
// Read from the Meta ads dashboard (awfmp-dashboard), whose Outbound tab shows
// our own ad spend (Finance's ledger), the prospects those ads bring in, how
// many booked, and the reps' texting queues. Its GET /api/outbound/summary
// returns the same figures that tab renders, from the same code, so the Scale
// Room can't drift from it.
//
// ADS_DASHBOARD_URL is the ads dashboard's public origin.
// OUTBOUND_SUMMARY_SECRET must equal the value set on the ads dashboard — its
// own secret, not CRON_SECRET or FINANCE_REVENUE_SECRET.

const TIMEOUT_MS = 25_000;

export async function getOutboundSummary(timeoutMs = TIMEOUT_MS): Promise<OutboundSummaryResult> {
  // Never throws: the Scale Room and the Growth Brain both call this, and an
  // ads dashboard outage should cost one block, not the page or the brief.
  try {
    const base = process.env.ADS_DASHBOARD_URL?.trim().replace(/\/+$/, "");
    const secret = process.env.OUTBOUND_SUMMARY_SECRET?.trim();
    if (!base || !secret) {
      return { ok: false, error: "Not configured — set ADS_DASHBOARD_URL and OUTBOUND_SUMMARY_SECRET" };
    }

    let url: URL;
    try {
      url = new URL(`${base}/api/outbound/summary`);
    } catch {
      return { ok: false, error: "ADS_DASHBOARD_URL is not a valid URL" };
    }
    // ADS_DASHBOARD_URL is an origin. A query or fragment on it would swallow
    // the path we append and send the request somewhere else on that host.
    if (url.search || url.hash) {
      return { ok: false, error: "ADS_DASHBOARD_URL must be a plain origin, without ? or #" };
    }
    // The secret rides in a header, so it must never go out in cleartext.
    // http is allowed only for an ads dashboard running locally.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return { ok: false, error: "ADS_DASHBOARD_URL must be https" };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        cache: "no-store",
        // The ads dashboard's middleware answers any path it doesn't exempt
        // with a 307 to /login — which is what an undeployed route looks like.
        // Following it would hand us an HTML login page; stopping here lets the
        // block say what actually happened.
        redirect: "manual",
        // Bound the wait. The summary reads every prospect plus Finance's
        // ledger, so leave it real room — but a dashboard that is down should
        // cost this block a clear message, not hang it.
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `Ads dashboard did not answer within ${Math.round(timeoutMs / 1000)}s` };
      }
      return { ok: false, error: `Network error: ${(e as Error).message}` };
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      return { ok: false, error: `Ads dashboard redirected (HTTP ${res.status}) — is /api/outbound/summary deployed there?` };
    }

    const ct = res.headers.get("content-type") ?? "";
    const isJson = ct.toLowerCase().includes("json");

    // Status before content-type: the ads dashboard answers 401/503 as JSON
    // with the reason, and "wrong secret" is far more useful than "non-JSON".
    if (!res.ok) {
      let reason = "";
      if (isJson) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        if (typeof body?.error === "string") reason = ` ${body.error}`;
      } else {
        await res.body?.cancel();
      }
      return { ok: false, error: `HTTP ${res.status}${reason}` };
    }

    if (!isJson) {
      await res.body?.cancel();
      return { ok: false, error: `Ads dashboard returned ${ct || "non-JSON"} (HTTP ${res.status})` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      // The timeout can also fire while the body is still arriving.
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `Ads dashboard did not answer within ${Math.round(timeoutMs / 1000)}s` };
      }
      return { ok: false, error: "Ads dashboard returned invalid JSON" };
    }
    if (!isSummary(json)) {
      return { ok: false, error: "Unexpected response shape from the ads dashboard" };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Outbound summary failed" };
  }
}

// Every field the Scale Room and the Growth Brain read, not just a few. The two
// apps deploy separately, so a renamed or dropped field must land here as
// "unexpected shape" (one block) rather than as a TypeError mid-render — /scale
// has no error boundary, and Suspense doesn't catch, so that would take the
// whole page.
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Null is a real answer on these ("no ledger row", "nothing to divide") — but
// it has to be null, not missing or a string.
const isNumOrNull = (v: unknown) => v === null || isNum(v);
const isStrOrNull = (v: unknown) => v === null || isStr(v);

function isCampaign(v: unknown): boolean {
  return isObj(v) && isStr(v.campaignName) && isNum(v.spend);
}

function isMonth(v: unknown): boolean {
  return (
    isObj(v) && isStr(v.period) && /^\d{4}-\d{2}$/.test(v.period) &&
    isNumOrNull(v.spend) && typeof v.isEstimate === "boolean" && typeof v.beforeTracking === "boolean" &&
    isNum(v.prospects) && isObj(v.bySource) && Object.values(v.bySource).every(isNum) &&
    isNum(v.booked) && isNumOrNull(v.costPerLead) && isNumOrNull(v.costPerBooked) &&
    isNumOrNull(v.unattributed) &&
    Array.isArray(v.campaigns) && v.campaigns.every(isCampaign)
  );
}

function isRep(v: unknown): boolean {
  return isObj(v) && isStr(v.owner) && isNum(v.queued) && isNum(v.dailyCap);
}

function isAds(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (v.ok === false) return isStr(v.error);
  return (
    v.ok === true && isStr(v.accountLabel) &&
    isStrOrNull(v.lastSyncedAt) && isStrOrNull(v.lastError) && isStrOrNull(v.campaignsError) &&
    Array.isArray(v.months) && v.months.every(isMonth)
  );
}

function isSummary(raw: unknown): raw is OutboundSummaryResponse {
  if (!isObj(raw) || !isStr(raw.generatedAt)) return false;
  const p = raw.pipeline;
  if (!isObj(p) || !isNum(p.total) || !isNum(p.booked) || !isNum(p.notBooked)) return false;
  const q = raw.queues;
  if (!isObj(q) || !Array.isArray(q.reps) || !q.reps.every(isRep) || !isNum(q.backlog)) return false;
  return isAds(raw.ads);
}
