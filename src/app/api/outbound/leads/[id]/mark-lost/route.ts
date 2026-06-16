import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import {
  transitionLead, recordEvent, getLeadById, cancelAllPending
} from "@/lib/outbound-leads";
import { notifyMarkedLost } from "@/lib/outbound-slack";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/mark-lost
//
// Rep gives up on the lead. Terminal state — every pending message
// canceled. Allowed transitions: warm_lead, booked, showed, no_show → lost.

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const existing = await getLeadById(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const updated = await transitionLead(id, "lost", {
      marked_lost_at: new Date().toISOString()
    });
    await recordEvent(id, "marked_lost", { by: me.id });
    await cancelAllPending(id);
    await notifyMarkedLost(updated);
    return NextResponse.json({ ok: true, lead: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "transition failed" },
      { status: 400 }
    );
  }
}
