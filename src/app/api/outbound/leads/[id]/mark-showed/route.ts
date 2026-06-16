import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { transitionLead, recordEvent, getLeadById } from "@/lib/outbound-leads";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/mark-showed
//
// Rep marks the lead as having attended their meeting. State transition
// is booked → showed (the state machine in outbound-leads.ts:transitionLead
// rejects this from any other state). No drip side-effects — engagement
// drip only fires on no-show or sold/lost terminal marks.

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
    const updated = await transitionLead(id, "showed");
    await recordEvent(id, "marked_showed", { by: me.id });
    return NextResponse.json({ ok: true, lead: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "transition failed" },
      { status: 400 }
    );
  }
}
