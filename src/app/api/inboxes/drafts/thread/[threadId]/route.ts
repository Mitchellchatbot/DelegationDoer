import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getReplyDraft, deleteReplyDraft } from "@/lib/inbox-drafts";

export const dynamic = "force-dynamic";

// GET /api/inboxes/drafts/thread/[threadId] — the caller's reply draft for a
// thread, or { draft: null }. Loaded when the ReplyComposer mounts so an
// in-progress reply re-hydrates after a reload / navigation.
export async function GET(
  _req: Request,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const draft = await getReplyDraft(userId, params.threadId);
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/inboxes/drafts/thread/[threadId] — explicit discard of a reply
// draft (the composer's Discard button).
export async function DELETE(
  _req: Request,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    await deleteReplyDraft(userId, params.threadId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
