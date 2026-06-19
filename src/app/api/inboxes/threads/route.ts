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
//   mailboxIds  — comma-separated account ids ("Selected inboxes" view);
//                 intersected with the caller's visible set, narrows within it
//                 only. Ignored when mailboxId is also present.
//   folder      — "INBOX" | "SENT" | "SPAM", default INBOX
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
    // Multi-inbox scope for the "Selected inboxes" view. Comma-separated ids;
    // intersected with visibility below so it can only narrow within the
    // caller's visible set, never widen past it.
    const requestedMailboxIds = (sp.get("mailboxIds") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    // Whitelist the mailbox view; anything unknown falls back to INBOX so
    // a bad param can never widen the query past the provider folders.
    const rawFolder = sp.get("folder");
    const folder: "INBOX" | "SENT" | "SPAM" =
      rawFolder === "SENT" || rawFolder === "SPAM" ? rawFolder : "INBOX";
    // Smart-filter bucket. Backend rejects unknown values, so we
    // narrow to the missiveclone CATEGORY_CLAUSES set.
    const ALLOWED = new Set(["codes", "newsletters", "receipts", "calendar", "people", "bounces"]);
    const rawCat = sp.get("category")?.trim();
    const category = rawCat && ALLOWED.has(rawCat)
      ? (rawCat as "codes" | "newsletters" | "receipts" | "calendar" | "people" | "bounces")
      : undefined;
    const teamSpaceId = sp.get("teamSpaceId") || undefined;

    // Resolve visibility BEFORE the thread fetch so we can scope the query
    // server-side. The combined view used to fetch the whole workspace and
    // filter by account_emails here — but with offset/hasMore taken from the
    // raw (pre-filter) page, the cursor drifted and the list never finished
    // loading. Scoping by mailbox id(s) makes pagination exact instead.
    const [accounts, visibleIds] = await Promise.all([
      listAccounts(),
      visibleAccountIdsFor(me)
    ]);
    const visibleAccounts = visibleIds === null
      ? accounts
      : accounts.filter((a) => visibleIds.has(a.id));

    // Determine the effective mailbox scope.
    //  - explicit mailboxId (single-inbox view): allow only if visible.
    //  - explicit mailboxIds ("Selected inboxes"): intersect with visibility.
    //  - no scope, non-leader: scope to all visible inbox ids.
    //  - no scope, leader (visibleIds === null): whole workspace.
    let scope: { mailboxId?: string; mailboxIds?: string[] };
    if (mailboxId) {
      if (visibleIds !== null && !visibleIds.has(mailboxId)) {
        // Requested an inbox the caller can't see — return empty, don't leak.
        return NextResponse.json({ threads: [], limit, offset, hasMore: false });
      }
      scope = { mailboxId };
    } else if (requestedMailboxIds.length > 0) {
      // Keep only ids the caller may see. Leaders (visibleIds === null) can
      // pick any real account; everyone else is clamped to their visible set.
      const accountIdSet = new Set(accounts.map((a) => a.id));
      const allowed = requestedMailboxIds.filter((id) =>
        visibleIds === null ? accountIdSet.has(id) : visibleIds.has(id)
      );
      if (allowed.length === 0) {
        // Nothing survives the visibility intersection — return empty; never
        // fall through to a wider scope.
        return NextResponse.json({ threads: [], limit, offset, hasMore: false });
      }
      scope = { mailboxIds: allowed };
    } else if (visibleIds !== null) {
      if (visibleAccounts.length === 0) {
        return NextResponse.json({ threads: [], limit, offset, hasMore: false });
      }
      scope = { mailboxIds: visibleAccounts.map((a) => a.id) };
    } else {
      scope = {};
    }

    const page = await listThreadsPaged({
      folder, limit, offset, q, category, teamSpaceId, ...scope
    });

    // The backend now restricts to the in-scope inboxes, so this filter is
    // a no-op for an up-to-date backend (any thread it returns via
    // account_id ∈ mailbox_ids necessarily carries that account's email in
    // account_emails) — which keeps the offset/hasMore cursor exact. It's
    // kept purely as a defensive backstop so a stale backend that ignores
    // mailbox_ids can't leak inboxes the caller may not see.
    // When a concrete id scope is in play (selected view, single inbox, or
    // non-leader "all visible"), build the allow-set from exactly those ids so
    // the backstop agrees with the selected subset — not the full visible set.
    // A leader with no id scope keeps null (whole workspace, nothing to hide).
    const scopeIds = scope.mailboxIds ?? (scope.mailboxId ? [scope.mailboxId] : null);
    const scopeIdSet = scopeIds ? new Set(scopeIds) : null;
    const visibleEmails = scopeIdSet
      ? new Set(
          accounts.filter((a) => scopeIdSet.has(a.id)).map((a) => a.email.toLowerCase())
        )
      : visibleIds === null
        ? null
        : new Set(visibleAccounts.map((a) => a.email.toLowerCase()));
    const inScope = visibleEmails === null
      ? page.threads
      : page.threads.filter((t) =>
          (t.account_emails ?? []).some((ae) => visibleEmails.has(ae.email.toLowerCase()))
        );

    const readByThread = await readStateForThreads(userId, inScope.map((t) => t.id));
    const decorated = inScope.map((t) => ({
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
