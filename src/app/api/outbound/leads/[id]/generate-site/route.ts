import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { getLeadById } from "@/lib/outbound-leads";
import { triggerWebsiteBuild } from "@/lib/website-builder-integration";

export const dynamic = "force-dynamic";

// POST /api/outbound/leads/[id]/generate-site
//   body: { companyWebsiteUrl?: string }  (optional override)
//
// Manual trigger (or retry) of the Website-Builder pipeline for a lead.
// Same code path as the auto-trigger in the Typeform webhook — the
// difference is that here the rep can supply a corrected
// company_website_url via the body (e.g. when the auto-extraction
// missed it, or when the originally-submitted URL was wrong).
//
// State after success: outbound_leads gets wb_lead_id, wb_build_id,
// wb_build_status seeded with whatever the WB pipeline returns; the
// status-sync cron takes over from there.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const existing = await getLeadById(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let overrideUrl: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { companyWebsiteUrl?: unknown };
    if (typeof body.companyWebsiteUrl === "string" && body.companyWebsiteUrl.trim()) {
      overrideUrl = body.companyWebsiteUrl.trim();
    }
  } catch {
    /* empty body is fine */
  }

  const result = await triggerWebsiteBuild(id, {
    companyWebsiteUrlOverride: overrideUrl ?? null
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    status: result.status,
    wbBuildId: result.wbBuildId,
    demoUrl: result.demoUrl
  });
}
