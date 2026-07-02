import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { getThread, fetchMessageBody } from "@/lib/missive-client";

export const dynamic = "force-dynamic";

// GET /api/inboxes/messages/[id]/body?account=<accountId>&thread=<threadId>
//
// Returns a single message's HTML/text body from the missive clone, for the
// lazy/deferred-body flow (older messages in a thread arrive without their body
// and are fetched here when the user expands or replies to them). The clone's
// /api/messages/:id/body requires the workspace-wide service token, so we proxy
// and enforce the SAME per-user access as the attachment proxy: the user must
// see the inbox AND the message must belong to a thread they can actually see.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const accountId = req.nextUrl.searchParams.get("account") ?? "";
  const threadId = req.nextUrl.searchParams.get("thread") ?? "";
  if (!accountId || !threadId) {
    return NextResponse.json(
      { error: "account + thread query params required" },
      { status: 400 }
    );
  }

  // Inbox-level access — mirrors the thread detail page.
  const visible = await visibleAccountIdsFor(me);
  if (visible !== null && !visible.has(accountId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Bind the message to a thread the user is viewing: the thread must touch an
  // inbox the user can see AND the message id must belong to one of its
  // messages. Without this, a workspace-wide id could be fetched by guessing.
  // Same "touches at least one visible inbox" test as loadThreadDetail. We only
  // need message metadata here, so fetch with bodies deferred.
  let touchesVisible = false;
  let messageInThread = false;
  try {
    const detail = await getThread(threadId, { deferBodies: true });
    const threadAccountIds = new Set(detail.messages.map((m) => m.account_id));
    touchesVisible =
      visible === null || [...threadAccountIds].some((id) => visible.has(id));
    messageInThread = detail.messages.some((m) => m.id === params.id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "thread lookup failed" },
      { status: 502 }
    );
  }
  if (!touchesVisible || !messageInThread) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const body = await fetchMessageBody(params.id);
    return NextResponse.json(body, {
      headers: { "Cache-Control": "private, max-age=300" }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "message body fetch failed" },
      { status: 502 }
    );
  }
}
