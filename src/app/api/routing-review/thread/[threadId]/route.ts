import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getThread } from "@/lib/missive-client";
import { restrictionsFor } from "@/lib/restricted-senders";

export const dynamic = "force-dynamic";

// GET /api/routing-review/thread/:threadId — proxy the Missive thread
// detail so the dashboard can render the original email body without
// burning a token client-side. Truncates body_text per message so a
// 100-msg thread doesn't return a megabyte payload.
export async function GET(
  _req: Request,
  { params }: { params: { threadId: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const isLeader = me.role === "leader" || me.isAdmin === true;
  const isHead = me.role === "department_head";
  if (!isLeader && !isHead) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const detail = await getThread(params.threadId);

    // Sender-scoped privacy (see src/lib/restricted-senders.ts). Note this
    // route gates on ROLE only — it never checks visibleAccountIdsFor, so it
    // will happily hand a leader/dept-head 5000 chars per message of any
    // thread whose id they can name, private inbox included. That broader
    // inbox_privacy bypass predates this change and is tracked separately;
    // this guard closes it for restricted senders specifically.
    const restrict = await restrictionsFor(me);
    if (
      restrict &&
      (restrict.blocksMessages(detail.messages) || restrict.blocksThread(detail.thread))
    ) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const messages = detail.messages.map((m) => ({
      ...m,
      body_text: m.body_text ? m.body_text.slice(0, 5000) : null
    }));
    return NextResponse.json({ thread: detail.thread, messages });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
