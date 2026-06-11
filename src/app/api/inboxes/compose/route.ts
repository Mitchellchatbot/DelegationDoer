import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { composeNewThread } from "@/lib/missive-client";
import { sanitizeMediaUrls, fetchMediaAsAttachments } from "@/lib/media";
import { deleteDraftById } from "@/lib/inbox-drafts";

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

    // Optional scheduled send. Frontend passes an ISO string; the
    // missive clone interprets `send_at` epoch-ms via composeNewThread.
    const sendAt = typeof body.sendAt === "string" ? body.sendAt : null;
    let sendAtMs: number | undefined;
    if (sendAt) {
      const ms = new Date(sendAt).getTime();
      if (Number.isNaN(ms)) {
        return NextResponse.json({ error: "sendAt is not a valid date" }, { status: 400 });
      }
      if (ms <= Date.now() + 30_000) {
        return NextResponse.json(
          { error: "sendAt must be at least 30s in the future" },
          { status: 400 }
        );
      }
      sendAtMs = ms;
    }

    // Attachments forwarding. Skipped automatically on scheduled sends
    // because the missive clone rejects that combination.
    const attachmentItems = sanitizeMediaUrls(body.attachmentUrls);
    if (attachmentItems.length > 0 && sendAtMs) {
      return NextResponse.json(
        { error: "attachments are not supported on scheduled sends — send immediately or strip the attachments" },
        { status: 400 }
      );
    }
    const attachments = attachmentItems.length > 0
      ? await fetchMediaAsAttachments(attachmentItems)
      : undefined;

    const result = await composeNewThread({
      fromAccountId: accountId,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : undefined,
      sendAtMs,
      attachments
    });

    // If this send came from a saved compose draft, clear it now. Best-effort
    // so draft cleanup can't fail an otherwise-successful send.
    const draftId = typeof body.draftId === "string" && body.draftId.length > 0 ? body.draftId : null;
    if (draftId) await deleteDraftById(userId, draftId).catch(() => {});

    return NextResponse.json({
      ok: true,
      scheduled: !!sendAtMs,
      sendAt: sendAtMs ? new Date(sendAtMs).toISOString() : null,
      ...result
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
