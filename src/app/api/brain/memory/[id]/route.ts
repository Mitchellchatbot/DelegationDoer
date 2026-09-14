import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { updateMemory, forgetMemory } from "@/lib/brain-memory";

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

// PATCH /api/brain/memory/[id] — edit content/category (owner only).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const ok = await updateMemory(params.id, { content: body?.content, category: body?.category });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "update failed" }, { status: 500 });
}

// DELETE /api/brain/memory/[id] — forget (deactivate) a memory (owner only).
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const ok = await forgetMemory(params.id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "delete failed" }, { status: 500 });
}
