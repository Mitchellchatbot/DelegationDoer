import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { loadThreadDetail } from "@/lib/thread-detail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/inboxes/threads/[threadId]?account=<accountId>
//   Returns the thread + messages + reply-all sets for the reading pane.
//   Enforces the same access checks as the (legacy) thread page via
//   loadThreadDetail. 403 if the user can't see the inbox or the thread
//   doesn't belong to it.
export async function GET(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const accountId = req.nextUrl.searchParams.get("account") ?? "";
  if (!accountId) {
    return NextResponse.json({ error: "account required" }, { status: 400 });
  }

  const res = await loadThreadDetail(me, accountId, params.threadId);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.status });
  }
  return NextResponse.json(res.data);
}
