import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { getLeadById } from "@/lib/outbound-leads";
import { applyManualTransition } from "@/lib/outbound-transitions";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/mark-no-show
//
// Rep marks the lead as a no-show. State transition is booked → no_show.
// Side effects:
//   - Stamp no_show_at
//   - Cancel any pending reminders (they're moot now)
//   - Schedule the engagement drip (5 messages over 30 days)
//   - Slack ping so the team sees the loss

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
    const result = await applyManualTransition(id, "no_show", { by: me.id });
    return NextResponse.json({ ok: true, lead: result.lead, scheduled: result.scheduled });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "transition failed" },
      { status: 400 }
    );
  }
}
