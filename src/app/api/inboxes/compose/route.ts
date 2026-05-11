import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { composeNewThread } from "@/lib/missive-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inboxes/compose
//   body: {
//     accountId: string,
//     to: string[],
//     cc?: string[],
//     bcc?: string[],
//     subject: string,
//     bodyText: string,
//     bodyHtml?: string
//   }
//
// Sends a brand-new outbound email through the chosen Missive account.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const bodyText = typeof body.bodyText === "string" ? body.bodyText.trim() : "";
    const to: string[] = Array.isArray(body.to)
      ? body.to.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const cc: string[] = Array.isArray(body.cc)
      ? body.cc.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const bcc: string[] = Array.isArray(body.bcc)
      ? body.bcc.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

    if (!accountId || !subject || !bodyText || to.length === 0) {
      return NextResponse.json(
        { error: "accountId + subject + bodyText + at least one recipient required" },
        { status: 400 }
      );
    }

    const visible = await visibleAccountIdsFor(me);
    if (visible !== null && !visible.has(accountId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const result = await composeNewThread({
      fromAccountId: accountId,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : undefined
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
