import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner, OWNER_EMAIL } from "@/lib/access";
import { addMemory } from "@/lib/brain-memory";

export const dynamic = "force-dynamic";

// POST /api/brain/feedback — Mitchell teaches the brain from a specific item.
// Owner only. Writes his correction to brain memory (category "preference"),
// which is injected into every future brief + chat, so the brain learns and
// won't repeat the mistake. Body: { verdict: "up"|"down", item: string, why?: string }
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return NextResponse.json({ error: "not found" }, { status: 404 });

    const body = await req.json().catch(() => null);
    const verdict = body?.verdict === "up" || body?.verdict === "down" ? body.verdict : null;
    const item = typeof body?.item === "string" ? body.item.trim().slice(0, 400) : "";
    const why = typeof body?.why === "string" ? body.why.trim().slice(0, 400) : "";
    if (!verdict || !item) return NextResponse.json({ error: "verdict and item required" }, { status: 400 });
    // A thumbs-up with no reason carries no lesson — skip saving it.
    if (verdict === "up" && !why) return NextResponse.json({ ok: true, saved: false });

    const content = verdict === "down"
      ? `Feedback (thumbs-down) on the brain item: "${item}". Why it's wrong / what to change: ${why || "Mitchell marked it wrong — do not surface items like this again."} Treat this as a standing rule going forward.`
      : `Feedback (thumbs-up) on the brain item: "${item}". What Mitchell liked: ${why}. Do more like this.`;

    const mem = await addMemory(content, "preference", `agent:feedback:${OWNER_EMAIL}`);
    return NextResponse.json({ ok: true, saved: true, id: mem.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "feedback failed" }, { status: 500 });
  }
}
