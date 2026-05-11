import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { sendReply, getThread } from "@/lib/missive-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inboxes/threads/[threadId]/reply
//   body: {
//     accountId: string,
//     bodyText: string,
//     bodyHtml?: string,
//     to?: string[],  // defaults to the last inbound message's sender
//     cc?: string[]
//   }
//
// Proxies the reply through the Missive clone. The clone owns the SMTP
// send + thread bookkeeping; we just verify the caller is allowed to
// touch this inbox and forward the payload.
export async function POST(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const bodyText = typeof body.bodyText === "string" ? body.bodyText.trim() : "";
    const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml : undefined;
    if (!accountId || !bodyText) {
      return NextResponse.json(
        { error: "accountId + bodyText required" },
        { status: 400 }
      );
    }

    const visible = await visibleAccountIdsFor(me);
    if (visible !== null && !visible.has(accountId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Resolve a recipient list. If the caller didn't supply one, default
    // to the sender of the most recent inbound message so the reply goes
    // back to the human who wrote in.
    let to: string[] = Array.isArray(body.to)
      ? body.to.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const cc: string[] = Array.isArray(body.cc)
      ? body.cc.filter((s: unknown): s is string => typeof s === "string")
      : [];
    let subject: string | undefined;
    let inReplyTo: string | undefined;

    if (to.length === 0) {
      const detail = await getThread(params.threadId);
      const lastInbound = [...detail.messages]
        .reverse()
        .find((m) => m.direction === "inbound");
      const fromAddr = lastInbound?.from_addr ?? detail.messages.at(-1)?.from_addr ?? "";
      const justEmail = fromAddr.match(/<([^>]+)>/)?.[1] ?? fromAddr;
      if (justEmail) to = [justEmail];
      subject = detail.thread.subject?.startsWith("Re:")
        ? detail.thread.subject
        : `Re: ${detail.thread.subject ?? ""}`;
      inReplyTo = detail.messages.at(-1)?.message_id ?? undefined;
    }

    if (to.length === 0) {
      return NextResponse.json(
        { error: "no recipient (thread has no inbound sender to reply to)" },
        { status: 422 }
      );
    }

    const message = await sendReply({
      threadId: params.threadId,
      fromAccountId: accountId,
      bodyText,
      bodyHtml,
      to,
      cc,
      subject,
      inReplyTo
    });

    return NextResponse.json({ ok: true, message });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
