import { NextRequest, NextResponse } from "next/server";
import { getSupportUser } from "@/lib/support-auth";
import { getConversation, listMessages } from "@/lib/support-data";

export const dynamic = "force-dynamic";

// GET /api/support/conversations/[id]/messages
// Returns the conversation header + its full message thread (oldest first).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getSupportUser();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const conversation = await getConversation(id);
    if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const messages = await listMessages(id);
    return NextResponse.json({ conversation, messages });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to load thread" },
      { status: 500 }
    );
  }
}
