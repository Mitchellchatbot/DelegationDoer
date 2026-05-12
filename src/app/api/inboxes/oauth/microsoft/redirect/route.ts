import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments } from "@/lib/inbox-access";

export const dynamic = "force-dynamic";

// GET /api/inboxes/oauth/microsoft/redirect
//
// Single-hop helper: asks the Missive clone for its Microsoft OAuth
// authorize URL (using our service token, since /start is auth-gated on
// the clone side), then 302s the user's browser straight to Microsoft.
// On consent → Missive callback → Missive redirects back to
// /inboxes/manage?oauth=microsoft_ok&connectedAccount=<id>.
//
// Leader-only (same gate as the rest of /inboxes/manage) — connecting a
// shared inbox is a workspace-wide action.
export async function GET(req: NextRequest) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canManageAssignments(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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
  const origin = req.nextUrl.origin;
  const returnTo = `${origin}/inboxes/manage`;
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
