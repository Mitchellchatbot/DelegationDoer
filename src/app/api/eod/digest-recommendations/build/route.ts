import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isApprover } from "@/lib/email-approvers";
import { buildDigestForClient } from "@/lib/eod-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/eod/digest-recommendations/build
//   body: { clientName: string }
//
// Triggers the digest drafter for a specific client on demand. Used
// by the "Draft now" button on the /approvals recommendations card so
// an approver can force a draft outside the client's scheduled cadence
// day (e.g. shipping a one-off update before Friday's weekly tick).
//
// force=true skips the in-builder cadence-day check — when an
// approver clicks Draft now, that IS the decision; we don't want to
// also-rate-limit them.
//
// Auth: approver only.

interface Body {
  clientName?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
      return NextResponse.json({ error: "approver only" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "";
    if (!clientName) {
      return NextResponse.json({ error: "clientName required" }, { status: 400 });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const touched = await buildDigestForClient(clientName, dateStr, { force: true });
    return NextResponse.json({ ok: true, drafted: touched });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
