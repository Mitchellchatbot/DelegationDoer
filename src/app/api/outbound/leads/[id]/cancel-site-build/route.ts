import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { getLeadById } from "@/lib/outbound-leads";
import { cancelWebsiteBuild } from "@/lib/website-builder-integration";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/cancel-site-build
//
// Kills an in-flight Website-Builder run for this lead. Sends WB's
// /generate/{lead_website_id}/cancel and stamps DD's wb_build_status to
// 'cancelled' so the UI flips immediately (without waiting for the next
// status-sync tick).

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const existing = await getLeadById(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await cancelWebsiteBuild(id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
