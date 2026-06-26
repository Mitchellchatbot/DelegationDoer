import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { getLeadById } from "@/lib/outbound-leads";
import { moveLeadToSequence } from "@/lib/outbound-transitions";
import type { FlowKey } from "@/lib/outbound-flow-config";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/sequence   { to: "recovery" | "engagement" }
//
// Move a lead's active SMS nurture sequence — the endpoint the Flow board hits
// when a card is dragged between sequence columns. Cancels the lead's current
// pending sequence messages and schedules the target drip. Booking is NOT a
// valid target (a lead only enters Booking via a Calendly meeting), so it's
// rejected here. Does not change the lead's pipeline status.

const TARGETS: FlowKey[] = ["recovery", "engagement"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const existing = await getLeadById(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => ({} as { to?: string }));
  const to = body?.to;
  if (typeof to !== "string" || !(TARGETS as string[]).includes(to)) {
    return NextResponse.json(
      {
        error: to === "booking"
          ? "Booking is set when a Calendly meeting is booked"
          : "invalid target sequence"
      },
      { status: 400 }
    );
  }

  try {
    const result = await moveLeadToSequence(id, to as FlowKey, { by: me.id });
    return NextResponse.json({
      ok: true,
      lead: result.lead,
      scheduled: result.scheduled,
      canceled: result.canceled
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "sequence move failed" },
      { status: 400 }
    );
  }
}
