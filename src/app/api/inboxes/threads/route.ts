import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccounts, listThreadsPaged } from "@/lib/missive-client";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";

export const dynamic = "force-dynamic";

// GET /api/inboxes/threads — paginated thread fetch for client-side
// infinite scroll + search. Returns the same decorated shape the
// inbox pages expect ({ thread, unread }) and applies the same
// per-user visibility filter the SSR'd pages do.
//
// Query params (all optional):
//   limit       — page size, 1..200, default 50
//   offset      — rows to skip, default 0
//   q           — full-text query (subject / sender / body via missive
//                 tsvector + ILIKE operators on the missive side)
//   mailboxId   — scope to one connected account
//   folder      — "INBOX" | "SENT", default INBOX
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const sp = req.nextUrl.searchParams;
    const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
    const offset = Math.max(0, Number(sp.get("offset")) || 0);
    const q = sp.get("q")?.trim() || undefined;
    const mailboxId = sp.get("mailboxId") || undefined;
    const folder = (sp.get("folder") as "INBOX" | "SENT") || "INBOX";

    const [accounts, page, visibleIds] = await Promise.all([
      listAccounts(),
      listThreadsPaged({ folder, limit, offset, q, mailboxId }),
      visibleAccountIdsFor(me)
    ]);

    const visibleAccounts = visibleIds === null
      ? accounts
      : accounts.filter((a) => visibleIds.has(a.id));
    const visibleEmails = new Set(visibleAccounts.map((a) => a.email.toLowerCase()));

    const filtered = visibleIds === null
      ? page.threads
      : page.threads.filter((t) =>
          (t.account_emails ?? []).some((ae) => visibleEmails.has(ae.email.toLowerCase()))
        );

    const readByThread = await readStateForThreads(userId, filtered.map((t) => t.id));
    const decorated = filtered.map((t) => ({
      thread: t,
      unread: isThreadUnread(t.last_message_at, readByThread.get(t.id))
    }));

    return NextResponse.json({
      threads: decorated,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
