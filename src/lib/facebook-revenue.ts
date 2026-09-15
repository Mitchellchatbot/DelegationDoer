import "server-only";

import type { FacebookRevenueData, FacebookRevenueResult } from "./facebook-revenue-types";

// Facebook-side revenue for the owner-only /finance page.
//
// Read from the Finance app (scaledai-finance — the "Finance" tab in the
// Meta ads dashboard), which prices Meta ad spend against each client's
// contract. Its GET /api/revenue returns the same figures its own P&L page
// renders, so this card can't drift from that one. Shown beside MRR, never
// added to it.
//
// FINANCE_URL is the Finance app's public origin (the same name the ads
// dashboard uses for it). FINANCE_REVENUE_SECRET must equal the value set
// on the Finance app — its own secret, not CRON_SECRET.

const TIMEOUT_MS = 25_000;

export async function getFacebookRevenue(timeoutMs = TIMEOUT_MS): Promise<FacebookRevenueResult> {
  // Never throws: the page renders this inside the owner's Finance view, and
  // a Finance app outage should cost one card, not the page.
  try {
    const base = process.env.FINANCE_URL?.trim().replace(/\/+$/, "");
    const secret = process.env.FINANCE_REVENUE_SECRET?.trim();
    if (!base || !secret) {
      return { ok: false, error: "Not configured — set FINANCE_URL and FINANCE_REVENUE_SECRET" };
    }

    let url: URL;
    try {
      url = new URL(`${base}/api/revenue`);
    } catch {
      return { ok: false, error: "FINANCE_URL is not a valid URL" };
    }
    // FINANCE_URL is an origin. A query or fragment on it would swallow the
    // path we append and send the request somewhere else on that host.
    if (url.search || url.hash) {
      return { ok: false, error: "FINANCE_URL must be a plain origin, without ? or #" };
    }
    // The secret rides in a header, so it must never go out in cleartext.
    // http is allowed only for a Finance app running locally.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return { ok: false, error: "FINANCE_URL must be https" };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        cache: "no-store",
        // The Finance app's session middleware answers anything it doesn't
        // exempt with a 307 to /login. Following it would hand us an HTML
        // login page; stopping here lets the card say what actually happened.
        redirect: "manual",
        // Bound the wait. The Finance app retries a slow query (bounded per
        // attempt and per query), so leave it real room — but a Finance app
        // that is down should cost this card a clear message, not hang it.
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `Finance app did not answer within ${Math.round(timeoutMs / 1000)}s` };
      }
      return { ok: false, error: `Network error: ${(e as Error).message}` };
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      return { ok: false, error: `Finance app redirected (HTTP ${res.status}) — is /api/revenue deployed there?` };
    }

    const ct = res.headers.get("content-type") ?? "";
    const isJson = ct.toLowerCase().includes("json");

    // Status before content-type: the Finance app answers 401/503 as JSON
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
      return { ok: false, error: `Finance app returned ${ct || "non-JSON"} (HTTP ${res.status})` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      // The timeout can also fire while the body is still arriving.
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `Finance app did not answer within ${Math.round(timeoutMs / 1000)}s` };
      }
      return { ok: false, error: "Finance app returned invalid JSON" };
    }
    if (!isRevenue(json)) {
      return { ok: false, error: "Unexpected response shape from the Finance app" };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Facebook revenue failed" };
  }
}

// Every field the card reads, not just a few. The two apps deploy separately,
// so a renamed or dropped field must land here as "unexpected shape" (one
// card) rather than as a TypeError mid-render — /finance has no error
// boundary, and Suspense doesn't catch, so that would take the whole page.
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isDay = (v: unknown) => v === null || (isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v));

function isMonth(v: unknown): boolean {
  const m = v as Record<string, unknown> | null;
  return (
    !!m && isStr(m.period) && /^\d{4}-\d{2}$/.test(m.period) &&
    isNum(m.revenue) && isNum(m.managementFees) && isNum(m.oneOffRevenue) &&
    isNum(m.managedSpend) && isNum(m.feeBearingSpend)
  );
}

function isPayer(v: unknown): boolean {
  const p = v as Record<string, unknown> | null;
  return (
    !!p && isStr(p.name) &&
    isNum(p.revenue) && isNum(p.feeBillable) && isNum(p.oneOffTotal) && isNum(p.managedSpend) &&
    (p.closingRate === null || isNum(p.closingRate)) &&
    isDay(p.lastDay) && isNum(p.gapDays) && isNum(p.unpricedSpend)
  );
}

function isRevenue(raw: unknown): raw is FacebookRevenueData {
  const r = raw as Record<string, unknown> | null;
  if (!r || !isStr(r.period) || !isStr(r.generatedAt) || typeof r.provisional !== "boolean") return false;
  if (!isDay(r.monthEnd) || r.monthEnd === null || !isDay(r.asOf) || !isMonth(r.current)) return false;
  if (!Array.isArray(r.months) || !r.months.every(isMonth)) return false;
  if (!Array.isArray(r.payers) || !r.payers.every(isPayer)) return false;
  const d = r.delta as Record<string, unknown> | null | undefined;
  return d === null || d === undefined || (isStr(d.label) && (d.tone === "up" || d.tone === "down" || d.tone === "flat"));
}
