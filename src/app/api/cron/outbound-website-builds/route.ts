import { NextResponse } from "next/server";
import { syncWebsiteBuildStatuses } from "@/lib/website-builder-integration";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Runs every minute. For each outbound_lead with a non-terminal
// wb_build_status, fetches the matching lead_websites row from
// Website-Builder's Supabase and copies status / netlify_url back. The
// moment a build hits 'awaiting_approval' we fire WB's deploy step
// (locked auto-deploy: DD users never block on human approval). All
// per-lead failures are returned in the payload but never throw — one
// bad row doesn't poison the tick.
export async function GET() {
  try {
    const outcome = await syncWebsiteBuildStatuses();
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
