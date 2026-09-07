import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

// GET /api/inboxes/oauth/microsoft/redirect
//
// Single-hop helper: asks the Missive clone for its Microsoft OAuth
// authorize URL (using our service token, since /start is auth-gated on
// the clone side), then 302s the user's browser straight to Microsoft.
// On consent → Missive callback → Missive redirects back to
// /inboxes/manage?oauth=microsoft_ok&connectedAccount=<id>.
//
// Any signed-in user can connect their own inbox now — matches the
// password path which dropped the leader-only gate. Auto-assignment
// of the resulting account to the connector is handled on the Missive
// side via the `user_id` it stamps onto the row.
export async function GET(req: NextRequest) {
  await requireCurrentUserId();

  const missiveBase = process.env.MISSIVE_API_URL?.replace(/\/$/, "");
  const missiveToken = process.env.MISSIVE_API_TOKEN;
  if (!missiveBase || !missiveToken) {
    return NextResponse.json(
      { error: "MISSIVE_API_URL or MISSIVE_API_TOKEN not set" },
      { status: 500 }
    );
  }

  // Tell Missive where to send the user after the callback completes.
  // We bounce them straight back to /inboxes/manage so the new tab is
  // visible without any extra navigation.
  //
  // NOT req.nextUrl.origin. Behind Railway / the desktop widget / proxies that
  // can resolve to an internal or localhost hostname even in production, and we
  // don't want Microsoft → Missive callback → "localhost refused to connect"
  // after a successful consent. That warning is why this used to prefer
  // NEXT_PUBLIC_APP_URL outright.
  //
  // publicOrigin() keeps that guarantee and drops the cost: it reads
  // x-forwarded-host — the public host the browser actually asked for, not the
  // internal one — and only trusts it if it is one of ours, falling back to the
  // configured URL otherwise. So consent started on operations.scaledai.org now
  // returns there instead of to the Railway host and its separate session.
  const returnTo = `${publicOrigin()}/inboxes/manage`;
  const startUrl =
    `${missiveBase}/api/oauth/microsoft/start?return_to=${encodeURIComponent(returnTo)}`;

  const res = await fetch(startUrl, {
    headers: { Authorization: `Bearer ${missiveToken}` },
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Missive /oauth/microsoft/start → ${res.status}`, detail: detail.slice(0, 400) },
      { status: 502 }
    );
  }
  const data = (await res.json()) as { url?: string };
  if (!data.url) {
    return NextResponse.json({ error: "Missive returned no authorize URL" }, { status: 502 });
  }
  return NextResponse.redirect(data.url, { status: 302 });
}
