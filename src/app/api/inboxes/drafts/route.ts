import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { isLeader } from "@/lib/access";
import { sanitizeMediaUrls } from "@/lib/media";
import { listDraftsForUser, upsertDraft } from "@/lib/inbox-drafts";

export const dynamic = "force-dynamic";

// GET /api/inboxes/drafts — drafts for the Drafts folder, newest first. Regular
// users get their own (scoped to inboxes they can see); leaders + stealth admins
// get every user's drafts (oversight, via isLeader). `currentUserId` lets the
// client tell own drafts from others' (others' render read-only).
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const visible = await visibleAccountIdsFor(me);
    const drafts = await listDraftsForUser(userId, visible, isLeader(me));
    return NextResponse.json({ drafts, currentUserId: userId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// PUT /api/inboxes/drafts — autosave (insert-or-update). Handles both flavours:
//   reply draft   -> threadId set; id is derived server-side from (user, thread)
//   compose draft -> threadId null; id required (client-generated)
//   body: { id?, accountId?, threadId?, to[], cc[], bcc[], subject?,
//           bodyText, bodyHtml?, attachmentUrls? }
// Returns { draft } or { deleted: true } when the draft was empty.
export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const accountId = typeof body.accountId === "string" && body.accountId.length > 0 ? body.accountId : null;
    const threadId = typeof body.threadId === "string" && body.threadId.length > 0 ? body.threadId : null;
    const id = typeof body.id === "string" && body.id.length > 0 ? body.id : undefined;

    // Don't let a user stash a draft against an inbox they can't see.
    if (accountId) {
      const visible = await visibleAccountIdsFor(me);
      if (visible !== null && !visible.has(accountId)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }

    const toList: string[] = Array.isArray(body.to)
      ? body.to.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const ccList: string[] = Array.isArray(body.cc)
      ? body.cc.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const bccList: string[] = Array.isArray(body.bcc)
      ? body.bcc.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

    if (threadId === null && !id) {
      return NextResponse.json({ error: "id required for compose drafts" }, { status: 400 });
    }

    const draft = await upsertDraft({
      userId,
      id,
      accountId,
      threadId,
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject: typeof body.subject === "string" ? body.subject : null,
      bodyText: typeof body.bodyText === "string" ? body.bodyText : "",
      bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : null,
      attachments: sanitizeMediaUrls(body.attachmentUrls)
    });

    if (!draft) return NextResponse.json({ deleted: true });
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
