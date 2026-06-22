import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { getThread, fetchAttachment } from "@/lib/missive-client";

export const dynamic = "force-dynamic";

// GET /api/inboxes/attachments/[id]?account=<accountId>&thread=<threadId>
//
// Streams an email attachment's bytes from the missive clone. The clone's
// own /api/attachments/:id requires the service token (which is
// workspace-wide), so we can't expose it to the browser directly. Instead
// we proxy: enforce the SAME per-user access the thread page applies
// (visibleAccountIdsFor + the attachment must belong to a thread the user
// can actually see), then pipe the upstream body straight through.
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

  // Bind the attachment to a thread the user is viewing: the thread must touch
  // an inbox the user can see AND the attachment id must belong to one of its
  // messages. Without this, a workspace-wide id could be fetched by guessing.
  // The visibility test mirrors loadThreadDetail — "touches at least one
  // visible inbox" rather than the exact opened account — so an attachment
  // stays reachable when a thread is opened via a visible-but-non-thread
  // account (e.g. a reply draft opened through its "send FROM" inbox).
  let touchesVisible = false;
  let attachmentInThread = false;
  try {
    const detail = await getThread(threadId);
    const threadAccountIds = new Set(detail.messages.map((m) => m.account_id));
    touchesVisible =
      visible === null || [...threadAccountIds].some((id) => visible.has(id));
    attachmentInThread = detail.messages.some((m) =>
      (m.attachments ?? []).some((a) => a.id === params.id)
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "thread lookup failed" },
      { status: 502 }
    );
  }
  if (!touchesVisible || !attachmentInThread) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const upstream = await fetchAttachment(params.id);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `attachment fetch failed (${upstream.status})` },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  // Pipe the binary through unchanged, preserving filename + content-type
  // (the clone sets Content-Disposition: attachment; filename=...).
  const headers = new Headers();
  headers.set(
    "Content-Type",
    upstream.headers.get("content-type") ?? "application/octet-stream"
  );
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) headers.set("Content-Disposition", disposition);
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  headers.set("Cache-Control", "private, max-age=300");

  return new Response(upstream.body, { status: 200, headers });
}
