import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsersLight } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccountsCached } from "@/lib/missive-client";
import { listDeletedThreads, type ThreadSnapshot } from "@/lib/thread-deletions";

export const dynamic = "force-dynamic";

export interface TrashItem {
  threadId: string;
  // Every inbox this thread is currently deleted from, within the caller's
  // scope. Restore posts these back, so restoring from the combined view undoes
  // the whole delete while restoring from one inbox's Trash only affects it.
  accountIds: string[];
  accountEmails: string[];
  deletedAt: string;
  // Who binned it. Deletion is per-inbox and applies to the whole team, so
  // Trash names the person rather than leaving it anonymous. Null when the
  // user has since been off-boarded (deleted_by is ON DELETE SET NULL).
  deletedById: string | null;
  deletedByName: string | null;
  snapshot: ThreadSnapshot | null;
}

// GET /api/inboxes/trash — soft-deleted threads for the caller's scope.
//
// Query params (all optional, same semantics as /api/inboxes/threads):
//   mailboxId   — scope to one connected account
//   mailboxIds  — comma-separated ids, intersected with visibility
//   limit       — max deletion rows to scan, 1..200, default 100
//
// Rows are per (thread, account); this groups them by thread so a
// delete-from-all reads as one trashed conversation rather than N.
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const sp = req.nextUrl.searchParams;
    const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 100));
    const mailboxId = sp.get("mailboxId") || undefined;
    const requestedIds = (sp.get("mailboxIds") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);

    const [accounts, visibleIds] = await Promise.all([
      listAccountsCached(),
      visibleAccountIdsFor(me)
    ]);
    const visibleAccounts = visibleIds === null
      ? accounts
      : accounts.filter((a) => visibleIds.has(a.id));

    // Same scope resolution as the threads route: an explicit scope can only
    // narrow within what the caller may see, never widen past it.
    let scopeIds: string[];
    if (mailboxId) {
      if (visibleIds !== null && !visibleIds.has(mailboxId)) {
        return NextResponse.json({ items: [] });
      }
      scopeIds = [mailboxId];
    } else if (requestedIds.length > 0) {
      const existing = new Set(accounts.map((a) => a.id));
      scopeIds = requestedIds.filter((id) =>
        visibleIds === null ? existing.has(id) : visibleIds.has(id)
      );
    } else {
      scopeIds = visibleAccounts.map((a) => a.id);
    }
    if (scopeIds.length === 0) return NextResponse.json({ items: [] });

    const emailById = new Map(accounts.map((a) => [a.id, a.email]));
    const rows = await listDeletedThreads(scopeIds, limit);

    const byThread = new Map<string, TrashItem>();
    for (const r of rows) {
      const existing = byThread.get(r.threadId);
      if (existing) {
        existing.accountIds.push(r.accountId);
        const email = emailById.get(r.accountId);
        if (email) existing.accountEmails.push(email);
        // Rows arrive newest-first, so the first one seen is the latest delete.
        existing.snapshot = existing.snapshot ?? r.snapshot;
      } else {
        const email = emailById.get(r.accountId);
        byThread.set(r.threadId, {
          threadId: r.threadId,
          accountIds: [r.accountId],
          accountEmails: email ? [email] : [],
          deletedAt: r.deletedAt,
          deletedById: r.deletedBy,
          deletedByName: null,
          snapshot: r.snapshot
        });
      }
    }

    // Resolve "deleted by" names. Deletion is workspace-visible — binning a
    // thread out of support@ hides it from everyone who can see support@ — so
    // "who did this?" is the first question anyone opening Trash will have.
    // One users read, joined in memory, rather than N lookups.
    const items = [...byThread.values()];
    const needNames = new Set(
      items.map((i) => i.deletedById).filter((id): id is string => !!id)
    );
    if (needNames.size > 0) {
      const users = await getAllUsersLight().catch(() => []);
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      for (const item of items) {
        if (item.deletedById) {
          item.deletedByName = nameById.get(item.deletedById) ?? null;
        }
      }
    }

    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
