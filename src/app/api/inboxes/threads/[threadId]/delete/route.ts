import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccountsCached } from "@/lib/missive-client";
import {
  deleteThreadFromAccounts,
  restoreThread,
  sanitizeSnapshot
} from "@/lib/thread-deletions";
import { publish } from "@/lib/inbox-event-bus";

export const dynamic = "force-dynamic";
// Node runtime so this handler shares the in-process inbox event bus singleton
// with the SSE stream (/api/inbox-events) — mirrors the read route.
export const runtime = "nodejs";

// Resolve the caller's allowed subset of the requested inboxes. Returns null
// when the caller isn't a valid user.
async function allowedAccountIds(
  userId: string,
  requested: string[]
): Promise<string[] | null> {
  const me = await getUserById(userId);
  if (!me) return null;
  const [accounts, visibleIds] = await Promise.all([
    listAccountsCached(),
    visibleAccountIdsFor(me)
  ]);
  const existing = new Set(accounts.map((a) => a.id));
  // Leaders (visibleIds === null) may act on any real account; everyone else is
  // clamped to their visible set. Ids that don't exist are dropped either way,
  // so a bad request can never write a row for a phantom inbox.
  return requested.filter((id) =>
    existing.has(id) && (visibleIds === null || visibleIds.has(id))
  );
}

// POST /api/inboxes/threads/[threadId]/delete
//   body: { accountIds: string[], snapshot?: {...} }
//
// Soft-deletes the thread out of the given inboxes: nothing is removed from the
// missive clone, we just record the deletion (see lib/thread-deletions). The
// caller sends every inbox the user chose in the delete popover — one id for
// "delete from this inbox", several for "delete from all inboxes".
//
// `snapshot` is display metadata for the Trash list (subject/sender/snippet).
// It's sanitized, never trusted: a restore re-reads the live thread.
export async function POST(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json().catch(() => ({}));
    const requested: string[] = Array.isArray(body.accountIds)
      ? body.accountIds.filter((v: unknown): v is string => typeof v === "string")
      : [];
    if (requested.length === 0) {
      return NextResponse.json({ error: "accountIds required" }, { status: 400 });
    }

    const allowed = await allowedAccountIds(userId, requested);
    if (allowed === null) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (allowed.length === 0) {
      // Every requested inbox is invisible to the caller — refuse rather than
      // silently no-op, so the UI doesn't report a delete that didn't happen.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    await deleteThreadFromAccounts(
      params.threadId,
      allowed,
      userId,
      sanitizeSnapshot(body.snapshot)
    );

    // Bust the sidebar badge cache and refresh any concurrently-mounted list.
    for (const accountId of allowed) {
      publish({
        event: "thread:updated",
        account_id: accountId,
        thread_id: params.threadId,
        ts: Date.now()
      });
    }

    return NextResponse.json({ ok: true, accountIds: allowed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/inboxes/threads/[threadId]/delete
//   body: { accountIds: string[] }
//
// Restores the thread — the Undo toast and the Trash list's Restore both land
// here. accountIds is required (and visibility-checked, same as POST) so a
// restore can never resurrect a thread into an inbox the caller can't see; both
// callers already know the ids, since POST echoes back exactly what it deleted.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json().catch(() => ({}));
    const requested: string[] = Array.isArray(body.accountIds)
      ? body.accountIds.filter((v: unknown): v is string => typeof v === "string")
      : [];
    if (requested.length === 0) {
      return NextResponse.json({ error: "accountIds required" }, { status: 400 });
    }

    const allowed = await allowedAccountIds(userId, requested);
    if (allowed === null) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (allowed.length === 0) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    await restoreThread(params.threadId, allowed);

    for (const accountId of allowed) {
      publish({
        event: "thread:updated",
        account_id: accountId,
        thread_id: params.threadId,
        ts: Date.now()
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
