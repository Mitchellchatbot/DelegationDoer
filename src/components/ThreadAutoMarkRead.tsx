"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Mounts once when the thread detail page renders. Fires the
// mark-read upsert in the background — failures are silent (the worst
// case is the row still reads as unread on the next list refresh).
export function ThreadAutoMarkRead({
  threadId, accountId, readThroughAt, refresh = true
}: {
  threadId: string;
  accountId: string;
  readThroughAt: string | null;
  // When false, skip router.refresh() after the upsert. The inbox reading pane
  // passes false because it updates the list's unread badge locally (see
  // InboxSplit.markRead) — a router.refresh there would needlessly re-run the
  // whole list SSR on every open.
  refresh?: boolean;
}) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/inboxes/threads/${encodeURIComponent(threadId)}/read`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId, readThroughAt }),
            signal: ac.signal
          }
        );
        // Invalidate the client Router Cache so navigating Back to the
        // inbox list re-runs SSR with the fresh read-state and the unread
        // blip disappears without a manual refresh. router.refresh() does
        // not change this effect's deps, so it won't re-fire the effect.
        if (!cancelled && res.ok && refresh) router.refresh();
      } catch {
        /* aborted or network blip — row self-heals on next list SSR */
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [threadId, accountId, readThroughAt, router, refresh]);

  return null;
}
