"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { InboxThreadsClient } from "./InboxThreadsClient";
import type { ThreadListItem } from "./ThreadList";
import { SelectedInboxesPicker, type PickerInbox } from "./SelectedInboxesPicker";

// Stable empty reference so swapping initialThreads → [] (when the live scope
// no longer matches the SSR'd one) doesn't churn InboxThreadsClient's effects.
const NO_THREADS: ThreadListItem[] = [];

// Client wrapper for the "Selected inboxes" page. Owns the live selection so a
// change re-scopes the (still-mounted) thread list via a prop update — NOT a
// router navigation, which would re-run the force-dynamic SSR page and tear
// down the loaded list + scroll position. Persistence is a fire-and-forget PUT
// to /api/inbox-selection (re-intersected with visibility server-side).
export function SelectedInboxesView({
  candidates,
  initialSelectedIds,
  initialThreads,
  initialHasMore,
  accountIdByEmail,
  missiveAppUrl
}: {
  candidates: PickerInbox[];
  initialSelectedIds: string[];
  initialThreads: ThreadListItem[];
  initialHasMore: boolean;
  accountIdByEmail?: Record<string, string>;
  missiveAppUrl?: string;
}) {
  const [ids, setIds] = useState<string[]>(initialSelectedIds);

  // The scope the SSR'd initialThreads belongs to (constant). Lets
  // InboxThreadsClient show the SSR page on first paint, then refetch once the
  // live selection diverges instead of snapping back to those stale threads.
  const initialScopeKey = [...initialSelectedIds].sort().join(",");
  const matchesInitial = [...ids].sort().join(",") === initialScopeKey;

  const apply = useCallback((next: string[]) => {
    setIds(next);
    void fetch("/api/inbox-selection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountIds: next })
    })
      .then((r) => { if (!r.ok) throw new Error(); })
      .catch(() => {
        toast.error("Couldn't save your inbox selection — it may not stick on reload.");
      });
  }, []);

  return (
    <div className="space-y-3">
      <SelectedInboxesPicker candidates={candidates} selected={ids} onChange={apply} />
      {ids.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink/55">
          Pick one or more inboxes above to see their conversations combined here.
        </div>
      ) : (
        <InboxThreadsClient
          initialThreads={matchesInitial ? initialThreads : NO_THREADS}
          initialHasMore={matchesInitial ? initialHasMore : false}
          linkAccountId={ids[0] ?? "all"}
          accountIdByEmail={accountIdByEmail}
          missiveAppUrl={missiveAppUrl}
          mailboxIds={ids}
          initialScopeKey={initialScopeKey}
        />
      )}
    </div>
  );
}
