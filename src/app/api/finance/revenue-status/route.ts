import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { getFacebookRevenue } from "@/lib/facebook-revenue";

export const dynamic = "force-dynamic";

// GET /api/finance/revenue-status
//   Is the Finance app reachable from THIS running container, and if not, why?
//
//   "Facebook revenue unavailable — Network error: fetch failed" (2026-09-30)
//   could not be told apart from a misconfigured FINANCE_URL without shell
//   access to the container, because the only two observable states were "Not
//   configured" and a bare TypeError. This route makes the difference readable:
//   whether each var is set, which host the request actually goes to, and what
//   the connection did — as JSON, from production, in one request.
//
//   It reports the SHAPE of the config, never its value: the host is not a
//   secret and is the piece that identifies a wrong URL; the secret appears
//   only as set/length, enough to catch a truncated or whitespace-padded paste.
//   Compare secrets ACROSS the two apps in Railway, not here.
//
//   Deliberately NOT a data route: it returns the envelope of the payload
//   (period, freshness, how many payers) and none of the figures, so /finance
//   stays the only place revenue is rendered.
//
//   Owner-only, like every other /api/finance/* route — a non-owner gets the
//   same 404 the page gives them.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return NextResponse.json({ error: "not found" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawUrl = process.env.FINANCE_URL?.trim().replace(/\/+$/, "") ?? "";
  const secret = process.env.FINANCE_REVENUE_SECRET?.trim() ?? "";

  // Parse for reporting only. getFacebookRevenue does its own validation; this
  // must never be the place the rules live twice.
  let host: string | null = null;
  let protocol: string | null = null;
  try {
    const u = new URL(`${rawUrl}/api/revenue`);
    host = u.host;
    protocol = u.protocol.replace(":", "");
  } catch {
    // Left null — "financeUrl.set but host null" is itself the diagnosis.
  }

  // A shorter budget than the card's 25s: this is a probe someone is watching,
  // and a Finance app that needs longer than 10s is already the answer.
  const started = Date.now();
  const result = await getFacebookRevenue(10_000);
  const elapsedMs = Date.now() - started;

  return NextResponse.json({
    ok: result.ok,
    checkedAt: new Date().toISOString(),
    elapsedMs,
    config: {
      financeUrl: { set: rawUrl.length > 0, host, protocol },
      // Length only. FIN rejects anything under 32 chars, so a short value here
      // is a truncated paste rather than a network problem.
      financeRevenueSecret: { set: secret.length > 0, length: secret.length }
    },
    // Exactly what the card shows, so a report of one explains the other.
    error: result.ok ? null : result.error,
    payload: result.ok
      ? {
          period: result.data.period,
          asOf: result.data.asOf,
          provisional: result.data.provisional,
          generatedAt: result.data.generatedAt,
          payers: result.data.payers.length,
          months: result.data.months.length
        }
      : null
  });
}
