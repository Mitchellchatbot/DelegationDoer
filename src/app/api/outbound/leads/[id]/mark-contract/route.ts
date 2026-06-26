import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { getLeadById } from "@/lib/outbound-leads";
import { applyManualTransition } from "@/lib/outbound-transitions";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/mark-contract
//
// Rep marks the lead as having a contract out for signature. State
// transition is booked | showed | no_show → contract. No drip side effects.
// Delegates to applyManualTransition so the board + this button share one
// code path.

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
    const result = await applyManualTransition(id, "contract", { by: me.id });
    return NextResponse.json({ ok: true, lead: result.lead });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "transition failed" },
      { status: 400 }
    );
  }
}
