import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { getLatestGrowthBrief, startGrowthBriefGeneration, growthBriefStatus } from "@/lib/growth-brain";

export const dynamic = "force-dynamic";

async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

// GET — latest persisted brief + whether a regeneration is running (owner only).
// The client polls this after kicking off a POST.
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const { generating, lastError } = growthBriefStatus();
  return NextResponse.json({ brief: await getLatestGrowthBrief(), generating, error: lastError });
}

// POST — kick off a background regeneration and return immediately. No longer
// blocks on the 1-3 min model run (which used to 502). The client polls GET
// until the brief's timestamp advances.
export async function POST() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const { started, alreadyRunning } = startGrowthBriefGeneration();
  const brief = await getLatestGrowthBrief();
  return NextResponse.json({ started, alreadyRunning, generating: true, brief });
}
