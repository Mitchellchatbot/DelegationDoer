"use client";

import { useEffect } from "react";

// Mounts once when the thread detail page renders. Fires the
// mark-read upsert in the background — failures are silent (the worst
// case is the row still reads as unread on the next list refresh).
export function ThreadAutoMarkRead({
  threadId, accountId, readThroughAt
}: {
  threadId: string;
  accountId: string;
  readThroughAt: string | null;
}) {
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    fetch(`/api/inboxes/threads/${encodeURIComponent(threadId)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, readThroughAt }),
      signal: ac.signal
    }).catch(() => {});
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [threadId, accountId, readThroughAt]);

  return null;
}
