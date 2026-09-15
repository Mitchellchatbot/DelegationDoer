import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { generateGrowthBrief, getLatestGrowthBrief } from "@/lib/growth-brain";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

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

// GET — latest persisted growth brief (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  return NextResponse.json({ brief: await getLatestGrowthBrief() });
}

// POST — generate a fresh growth brief (owner only).
export async function POST() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  try {
    return NextResponse.json({ brief: await generateGrowthBrief() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "generation failed" }, { status: 500 });
  }
}
