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
// own secret, not CRON_SECRET or FINANCE_REVENUE_SECRET. It only READS.
// OUTBOUND_AGENT_SECRET (outbound-agent.ts) is a separate one that can write;
// it goes out only on the agent API's routes, never on these reads.

// Matches outbound-meta / outbound-board: the dashboard's live pull is slow at
// times, so wait long enough to actually show the numbers instead of a timeout.
const TIMEOUT_MS = 55_000;

export async function getOutboundSummary(timeoutMs = TIMEOUT_MS): Promise<OutboundSummaryResult> {
  return fetchAdsDashboard("/api/outbound/summary", isSummary, timeoutMs, "Outbound summary failed");
}

/** Which ads dashboard secret a request carries. Named, not free text, so a
 *  caller can't point this at an unrelated env var and ship it in a header. */
export type AdsDashboardSecretEnv = "OUTBOUND_SUMMARY_SECRET" | "OUTBOUND_AGENT_SECRET";

export interface AdsDashboardRequest {
  /** Default GET. */
  method?: "GET" | "POST" | "PATCH";
  /** Sent as JSON. Only for POST/PATCH. */
  body?: Record<string, unknown>;
  /** Default OUTBOUND_SUMMARY_SECRET — the read-only one. */
  secretEnv?: AdsDashboardSecretEnv;
}

export type AdsDashboardFailure = {
  ok: false;
  error: string;
  /** The HTTP status, when the ads dashboard answered with one. */
  status?: number;
  /** The ads dashboard's own `{ error }` text on a non-2xx, verbatim. */
  upstreamError?: string;
};

/**
 * GET one of the ads dashboard's secret-gated JSON routes and check its shape.
 *
 * Shared by the Scale Room's summary card, its Outbound tab
 * (outbound-board.ts) and its Meta view (outbound-meta.ts), so the checks in
 * requestAdsDashboard — plain https origin, secret only in a header, no
 * redirect following, bounded wait — exist once.
 *
 * Failures are exactly `{ ok, error }`: these results are handed to client
 * components as props, so the extra detail requestAdsDashboard keeps for the
 * agent API is dropped here rather than serialized into the page.
 *
 * Never throws: the Scale Room and the Growth Brain both call this, and an
 * ads dashboard outage should cost one block, not the page or the brief.
 */
export async function fetchAdsDashboard<T>(
  path: string,
  isShape: (raw: unknown) => raw is T,
  timeoutMs: number,
  fallbackError: string,
  request?: AdsDashboardRequest
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const r = await requestAdsDashboard(path, isShape, timeoutMs, fallbackError, request);
  return r.ok ? r : { ok: false, error: r.error };
}

/**
 * The one place a request to the ads dashboard is made: fetchAdsDashboard for
 * the Scale Room's reads, outbound-agent.ts for the agent API's reads and
 * writes. Same checks for both; a write additionally says, when it can't tell,
 * that the change may already have landed — so nobody retries a Meta budget
 * change blind.
 *
 * Never throws.
 */
export async function requestAdsDashboard<T>(
  path: string,
  isShape: (raw: unknown) => raw is T,
  timeoutMs: number,
  fallbackError: string,
  request: AdsDashboardRequest = {}
): Promise<{ ok: true; data: T } | AdsDashboardFailure> {
  const method = request.method ?? "GET";
  const secretEnv: AdsDashboardSecretEnv = request.secretEnv ?? "OUTBOUND_SUMMARY_SECRET";
  // Once a write has left, silence doesn't mean nothing happened.
  const unsure = method === "GET" ? "" : " — the change may or may not have been applied; re-read before retrying";
  try {
    if (method === "GET" && request.body !== undefined) {
      return { ok: false, error: "A GET to the ads dashboard can't carry a body" };
    }
    const base = process.env.ADS_DASHBOARD_URL?.trim().replace(/\/+$/, "");
    const secret = process.env[secretEnv]?.trim();
    if (!base || !secret) {
      return { ok: false, error: `Not configured — set ADS_DASHBOARD_URL and ${secretEnv}` };
    }

    let url: URL;
    try {
      // ADS_DASHBOARD_URL is an origin. A query or fragment on it would swallow
      // the path we append and send the request somewhere else on that host.
      // Checked on the base alone: `path` may carry its own query (?days=).
      const origin = new URL(base);
      if (origin.search || origin.hash) {
        return { ok: false, error: "ADS_DASHBOARD_URL must be a plain origin, without ? or #" };
      }
      url = new URL(`${base}${path}`);
    } catch {
      return { ok: false, error: "ADS_DASHBOARD_URL is not a valid URL" };
    }
    // The secret rides in a header, so it must never go out in cleartext.
    // http is allowed only for an ads dashboard running locally.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return { ok: false, error: "ADS_DASHBOARD_URL must be https" };
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, Accept: "application/json" };
    // Encoded before the request is made, so a body that can't be serialized
    // fails as a plain error (outer catch), never as "may have been applied".
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        cache: "no-store",
        // The ads dashboard's middleware answers any path it doesn't exempt
        // with a 307 to /login — which is what an undeployed route looks like.
        // Following it would hand us an HTML login page; stopping here lets the
        // block say what actually happened. (For a write it also means the
        // route never ran.)
        redirect: "manual",
        // Bound the wait. The summary reads every prospect plus Finance's
        // ledger, so leave it real room — but a dashboard that is down should
        // cost this block a clear message, not hang it.
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `Ads dashboard did not answer within ${Math.round(timeoutMs / 1000)}s${unsure}` };
      }
      return { ok: false, error: `Network error: ${(e as Error).message}${unsure}` };
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      return { ok: false, error: `Ads dashboard redirected (HTTP ${res.status}) — is ${path} deployed there?`, status: res.status };
    }

    const ct = res.headers.get("content-type") ?? "";
    const isJson = ct.toLowerCase().includes("json");

    // Status before content-type: the ads dashboard answers 401/503 as JSON
    // with the reason, and "wrong secret" is far more useful than "non-JSON".
    if (!res.ok) {
      if (isJson) {
        const reply = (await res.json().catch(() => null)) as { error?: unknown } | null;
        if (typeof reply?.error === "string") {
          return { ok: false, error: `HTTP ${res.status} ${reply.error}`, status: res.status, upstreamError: reply.error };
        }
        return { ok: false, error: `HTTP ${res.status}`, status: res.status };
      }
      await res.body?.cancel();
      // A JSON { error } is the ads dashboard itself refusing. A bare 5xx page
      // is more likely the host's proxy giving up — possibly after the route
      // had already written.
      return { ok: false, error: `HTTP ${res.status}${res.status >= 500 ? unsure : ""}`, status: res.status };
    }

    // From here the ads dashboard answered 2xx: a write went through, only the
    // reply is in question.
    const accepted = method === "GET" ? "" : " — the ads dashboard answered OK, so the change was likely applied; re-read to confirm";

    if (!isJson) {
      await res.body?.cancel();
      return { ok: false, error: `Ads dashboard returned ${ct || "non-JSON"} (HTTP ${res.status})${accepted}`, status: res.status };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      // The timeout can also fire while the body is still arriving.
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `Ads dashboard did not answer within ${Math.round(timeoutMs / 1000)}s${accepted}`, status: res.status };
      }
      return { ok: false, error: `Ads dashboard returned invalid JSON${accepted}`, status: res.status };
    }
    if (!isShape(json)) {
      return { ok: false, error: `Unexpected response shape from the ads dashboard${accepted}`, status: res.status };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : fallbackError };
  }
}

// Every field the Scale Room and the Growth Brain read, not just a few. The two
// apps deploy separately, so a renamed or dropped field must land here as
// "unexpected shape" (one block) rather than as a TypeError mid-render — /scale
// has no error boundary, and Suspense doesn't catch, so that would take the
// whole page.
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isStr = (v: unknown): v is string => typeof v === "string";
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Null is a real answer on these ("no ledger row", "nothing to divide") — but
// it has to be null, not missing or a string.
export const isNumOrNull = (v: unknown) => v === null || isNum(v);
export const isStrOrNull = (v: unknown) => v === null || isStr(v);

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

export function isRep(v: unknown): boolean {
  return isObj(v) && isStr(v.owner) && isNum(v.queued) && isNum(v.dailyCap);
}

export function isAds(v: unknown): boolean {
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
