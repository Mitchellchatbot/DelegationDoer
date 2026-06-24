import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { getLeadById } from "@/lib/outbound-leads";
import { applyManualTransition } from "@/lib/outbound-transitions";
import type { LeadStatus } from "@/lib/outbound-stages";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/transition   { to: LeadStatus, notes? }
//
// Generic manual stage move — the endpoint the kanban board hits when a
// card is dragged to a new column. Delegates to applyManualTransition, which
// validates the move against MANUAL_TRANSITIONS and fires the matching side
// effects (drip scheduling, SMS cancels, Slack). Booking (→ booked) is
// Calendly-only and rejected. notes is only used when moving to success.

const MANUAL_TARGETS: LeadStatus[] = [
  "warm_lead", "showed", "no_show", "contract", "success", "lost"
];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const existing = await getLeadById(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => ({} as { to?: string; notes?: string }));
  const to = body?.to;
  if (typeof to !== "string" || !(MANUAL_TARGETS as string[]).includes(to)) {
    return NextResponse.json({ error: "invalid target status" }, { status: 400 });
  }
  const notes = typeof body?.notes === "string" ? body.notes : null;

  try {
    const result = await applyManualTransition(id, to as LeadStatus, { by: me.id, notes });
    return NextResponse.json({
      ok: true,
      lead: result.lead,
      scheduled: result.scheduled,
      canceled: result.canceled
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "transition failed" },
      { status: 400 }
    );
  }
}
