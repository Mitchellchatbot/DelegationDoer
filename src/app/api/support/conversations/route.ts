import { NextRequest, NextResponse } from "next/server";
import { getSupportUser } from "@/lib/support-auth";
import { listConversations, type ConversationBucket } from "@/lib/support-data";

export const dynamic = "force-dynamic";

// GET /api/support/conversations?bucket=support|review
//   - support : the customer_support inbox (open conversations).
//   - review  : the Needs Review queue (uncertain classifications).
export async function GET(req: NextRequest) {
  const me = await getSupportUser();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const raw = (req.nextUrl.searchParams.get("bucket") ?? "support").toLowerCase();
  const bucket: ConversationBucket = raw === "review" ? "review" : "support";

  try {
    const conversations = await listConversations(bucket);
    return NextResponse.json({ conversations });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to load conversations" },
      { status: 500 }
    );
  }
}
