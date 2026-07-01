import { NextRequest, NextResponse } from "next/server";
import { getSupportUser } from "@/lib/support-auth";
import { getConversation } from "@/lib/support-data";
import { reclassifyConversation } from "@/lib/support-intake";

export const dynamic = "force-dynamic";

// POST /api/support/conversations/[id]/reclassify   { to: "support" | "lead" }
// Human override from the Needs Review queue:
//   - "support" : keep it in the customer-support inbox.
//   - "lead"    : route it into the existing outbound lead funnel.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getSupportUser();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => ({} as { to?: string }));
  const to = body?.to;
  if (to !== "support" && to !== "lead") {
    return NextResponse.json({ error: "to must be 'support' or 'lead'" }, { status: 400 });
  }

  const conversation = await getConversation(id);
  if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await reclassifyConversation(id, to);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "reclassify failed" },
      { status: 400 }
    );
  }
}
