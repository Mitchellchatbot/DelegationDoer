import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { sendReply } from "@/lib/missive-client";
import { deriveReply } from "@/lib/owner-inbox";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

// POST /api/brain/inbox/send — send an approved reply AS Mitchell. Owner only.
// The client only supplies threadId + bodyText; recipients, subject, and the
// sending account are re-derived server-side so nothing can be redirected.
// Body: { threadId, bodyText }
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const body = await req.json().catch(() => null);
  const threadId = typeof body?.threadId === "string" ? body.threadId : "";
  const bodyText = typeof body?.bodyText === "string" ? body.bodyText.trim() : "";
  if (!threadId || !bodyText) return NextResponse.json({ error: "threadId and bodyText required" }, { status: 400 });

  const routing = await deriveReply(threadId);
  if (!routing) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  if (!routing.to.length) return NextResponse.json({ error: "no recipient found on thread" }, { status: 400 });

  try {
    const { messageId } = await sendReply({
      threadId,
      bodyText,
      fromAccountId: routing.fromAccountId,
      to: routing.to,
      subject: routing.subject,
      inReplyTo: routing.inReplyTo
    });
    return NextResponse.json({ ok: true, messageId, to: routing.to });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "send failed" }, { status: 500 });
  }
}
