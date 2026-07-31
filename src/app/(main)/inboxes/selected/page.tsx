import { redirect } from "next/navigation";
import { Inbox } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { listAccountsCached, listThreadsPaged, INBOX_SSR_PAGE, type MissiveThread } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { getSelectedInboxIds } from "@/lib/selected-inboxes";
import { ComposeButton } from "@/components/ComposeButton";
import { InboxSplit } from "@/components/InboxSplit";
import { SelectedInboxesView } from "@/components/SelectedInboxesView";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";
import { filterDeletedThreads } from "@/lib/thread-deletions";
import { filterMutedThreads } from "@/lib/inbox-mute";

export const dynamic = "force-dynamic";

// Combined "the inboxes I cherry-picked" view (Smart → Selected inboxes). The
// chosen set lives in user_selected_inboxes per-user and is intersected with
// what the actor may see, so it can only ever narrow within their visible set.
// Source of truth is the DB (read here), so there's no localStorage/URL state
// and no hydration concern. The client wrapper handles live edits + scope.
export default async function SelectedInboxesPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  let inboxes: { id: string; email: string; display_name: string | null }[] = [];
  let selectedAccounts: { id: string; email: string; display_name: string | null }[] = [];
  let threads: MissiveThread[] = [];
  let hasMore = false;
  let fetchError: string | null = null;
  try {
    const [allAccounts, visibleIds, storedIds] = await Promise.all([
      listAccountsCached(),
      visibleAccountIdsFor(me),
      getSelectedInboxIds(userId)
    ]);

    inboxes = visibleIds === null
      ? allAccounts
      : allAccounts.filter((a) => visibleIds.has(a.id));

    // stored ∩ visible ∩ existing — stale or now-forbidden ids silently drop.
    const storedSet = new Set(storedIds);
    selectedAccounts = inboxes.filter((a) => storedSet.has(a.id));

    if (selectedAccounts.length > 0) {
      // SSR only the first page (50). The client wrapper streams in more on
      // scroll via /api/inboxes/threads with the same selected scope.
      const firstPage = await listThreadsPaged({
        folder: "INBOX",
        limit: INBOX_SSR_PAGE,
        mailboxIds: selectedAccounts.map((a) => a.id)
      });
      // Defensive backstop mirroring /api/inboxes/threads: clamp to the
      // selected inboxes' emails so a stale backend that ignores mailbox_ids
      // can't surface a non-selected inbox into the SSR'd first page.
      const selectedEmails = new Set(selectedAccounts.map((a) => a.email.toLowerCase()));
      threads = firstPage.threads.filter((t) =>
        (t.account_emails ?? []).some((ae) => selectedEmails.has(ae.email.toLowerCase()))
      );
      // Hide threads soft-deleted from every selected inbox (see
      // lib/thread-deletions) — one still-live inbox in the selection keeps the
      // thread on screen.
      threads = await filterDeletedThreads(
        threads,
        inboxes,
        new Set(selectedAccounts.map((a) => a.id))
      );
      threads = await filterMutedThreads(threads);
      hasMore = firstPage.hasMore;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const selectedCount = selectedAccounts.length;
  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");

  const readByThread = await readStateForThreads(userId, threads.map((t) => t.id));
  const decoratedThreads = threads.map((t) => ({
    thread: t,
    unread: isThreadUnread(t.last_message_at, readByThread.get(t.id))
  }));

  // Map every visible inbox's email → id so a thread's open-link resolves
  // regardless of which subset is currently selected.
  const accountIdByEmail = Object.fromEntries(
    inboxes.map((a) => [a.email.toLowerCase(), a.id])
  );
  // Reverse map for the delete picker's checkbox labels + Trash chips.
  const accountLabelById = Object.fromEntries(inboxes.map((a) => [a.id, a.email]));

  return (
    <InboxSplit>
    <div className="space-y-5">
      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
      >
        <div className="relative flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-white/60 backdrop-blur border border-white/60 grid place-items-center">
            <Inbox className="w-6 h-6 text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Selected inboxes</h1>
            <p className="text-xs text-ink/60 mt-0.5">
              {inboxes.length === 0
                ? "No inboxes you can see yet."
                : selectedCount === 0
                  ? "Cherry-pick the inboxes you want to follow together."
                  : `Combined view across ${selectedCount} inbox${selectedCount === 1 ? "" : "es"}`}
            </p>
          </div>
        </div>
        {selectedCount > 0 && (
          <div className="relative mt-3 flex items-center justify-end">
            <ComposeButton accounts={selectedAccounts} />
          </div>
        )}
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      {fetchError && (
        <div className="card p-4 border-urgent/30 bg-urgent/5 text-sm text-urgent">
          Couldn't load threads: {fetchError}
        </div>
      )}

      {!fetchError && (
        <SelectedInboxesView
          candidates={inboxes}
          initialSelectedIds={selectedAccounts.map((a) => a.id)}
          initialThreads={decoratedThreads}
          initialHasMore={hasMore}
          accountIdByEmail={accountIdByEmail}
          accountLabelById={accountLabelById}
          missiveAppUrl={missiveAppUrl || undefined}
        />
      )}
    </div>
    </InboxSplit>
  );
}
