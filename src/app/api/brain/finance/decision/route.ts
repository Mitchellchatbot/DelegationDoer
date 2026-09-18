import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner, OWNER_EMAIL } from "@/lib/access";
import { addMemory } from "@/lib/brain-memory";

export const dynamic = "force-dynamic";

// POST /api/brain/finance/decision — Mitchell teaches the finance brain what he's
// doing with a cost: keeping it (stop flagging) or cutting it (tracked). Writes
// to brain memory, which the finance chat reads and getFinanceOverview uses to
// drop the item from "Where to cut". Owner only.
// Body: { action: "keep" | "cut", name: string, note?: string }
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return NextResponse.json({ error: "not found" }, { status: 404 });

    const body = await req.json().catch(() => null);
    const action = body?.action === "keep" || body?.action === "cut" ? body.action : null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!action || !name) return NextResponse.json({ error: "action and name required" }, { status: 400 });

    // Content is prefixed "Finance keep:"/"Finance cut:" so getFinanceOverview
    // can parse the decided cost name and drop it from the cut list.
    const content = action === "keep"
      ? `Finance keep: ${name} — ${note || "essential, worth the cost"}. Don't flag it as a cut.`
      : `Finance cut: ${name}${note ? ` — ${note}` : ""}. Cutting this cost to save money.`;

    const mem = await addMemory(content, "decision", `agent:finance:${OWNER_EMAIL}`);
    return NextResponse.json({ ok: true, id: mem.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
