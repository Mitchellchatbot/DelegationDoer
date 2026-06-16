import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import {
  transitionLead, recordEvent, getLeadById,
  cancelMessagesByKind, scheduleEngagementDrip
} from "@/lib/outbound-leads";
import { notifyMarkedNoShow } from "@/lib/outbound-slack";

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
    const updated = await transitionLead(id, "no_show", {
      no_show_at: new Date().toISOString()
    });
    await recordEvent(id, "marked_no_show", { by: me.id });
    // Reminders that haven't fired yet (e.g. marked no-show before the
    // 1h reminder fired) are now moot.
    await cancelMessagesByKind(id, ["reminder_24h", "reminder_1h", "confirmation"]);
    const scheduled = await scheduleEngagementDrip(updated);
    await notifyMarkedNoShow(updated);
    return NextResponse.json({ ok: true, lead: updated, scheduled });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "transition failed" },
      { status: 400 }
    );
  }
}
