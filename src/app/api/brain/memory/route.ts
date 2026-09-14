import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { listMemories, addMemory } from "@/lib/brain-memory";

export const dynamic = "force-dynamic";

async function requireOwner(): Promise<{ ok: true; userId: string } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true, userId };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

// GET /api/brain/memory — list the brain's active memories (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  return NextResponse.json({ memories: await listMemories() });
}

// POST /api/brain/memory — add a memory (owner only).
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) return NextResponse.json({ error: "content required" }, { status: 400 });
  const mem = await addMemory(content, body?.category, gate.userId);
  return NextResponse.json({ memory: mem });
}
