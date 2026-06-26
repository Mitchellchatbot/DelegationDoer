import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { getLeadById } from "@/lib/outbound-leads";
import { applyManualTransition } from "@/lib/outbound-transitions";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/mark-sold
//
// Rep marks the lead as a closed sale. Terminal state — every pending
// scheduled message gets canceled. Accepts an optional { notes } body
// that's stored on the lead row and surfaced in the Slack ping.
//
// State transitions allowed from: booked, showed, no_show.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const existing = await getLeadById(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let notes: string | null = null;
  try {
    const body = await req.json().catch(() => ({} as { notes?: string }));
    if (typeof body?.notes === "string" && body.notes.trim()) {
      notes = body.notes.trim();
    }
  } catch {
    // Empty body is fine — notes is optional.
  }
  try {
    const result = await applyManualTransition(id, "success", { by: me.id, notes });
    return NextResponse.json({ ok: true, lead: result.lead });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "transition failed" },
      { status: 400 }
    );
  }
}
