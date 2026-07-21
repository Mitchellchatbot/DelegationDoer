import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { syncClientTouchpointsFromMissive } from "@/lib/touchpoint-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/clients/sync-touchpoints
// Walks missiveclone's SENT folder and writes the latest send date /
// subject onto each matching client. Drives the touchpoint
// dashboard's "last outbound email" reading for mail that didn't
// originate inside Scaled Operations.
//
// Leader/admin only — the operation is cheap (per-client UPDATE) but
// it does talk to missiveclone, so we don't want random callers
// hammering it.
export async function POST() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const result = await syncClientTouchpointsFromMissive();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
