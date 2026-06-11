"use client";

import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { useSearchParams } from "next/navigation";
import { ThreadReadingPane } from "@/components/ThreadReadingPane";

// Gmail/Outlook-style split for the inbox LIST routes only (wrapped around each
// list page's body — NOT the shared inboxes layout, so /inboxes/manage and
// other non-list routes stay full-width). The list sits in the left column and
// the selected email opens in the right reading pane.
//
// Selection is CLIENT-LOCAL state, deliberately not a Next router navigation:
// the list page is `force-dynamic`, so a router.push/refresh would re-run its
// SSR, hand InboxThreadsClient a fresh `initialThreads`, and reset the list
// (losing every infinite-scroll page + the scroll position). Local state +
// history.replaceState keeps the list mounted and untouched while still syncing
// the URL for refresh/deep-link.

interface Selected {
  accountId: string;
  threadId: string;
}

interface InboxSplitCtx {
  selected: Selected | null;
  select: (accountId: string, threadId: string) => void;
  isSelected: (threadId: string) => boolean;
  // Threads the user has opened this session — used to drop the unread style
  // in the live list without a server round-trip (the pane marks read).
  readIds: Set<string>;
  markRead: (threadId: string) => void;
}

const Ctx = createContext<InboxSplitCtx>({
  selected: null,
  select: () => {},
  isSelected: () => false,
  readIds: new Set(),
  markRead: () => {}
});

export const useInboxSplit = () => useContext(Ctx);

export function InboxSplit({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  // Hydrate the initial selection from the URL once (supports refresh, bookmarks
  // and the legacy /threads/[id] redirect). Subsequent selections are local.
  const [selected, setSelected] = useState<Selected | null>(() => {
    const threadId = searchParams.get("thread");
    const accountId = searchParams.get("acct");
    return threadId && accountId ? { accountId, threadId } : null;
  });
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());

  const select = useCallback((accountId: string, threadId: string) => {
    setSelected({ accountId, threadId });
    // Keep the address bar in sync WITHOUT a Next navigation (no SSR re-run, so
    // the list isn't reset). replaceState avoids stacking history entries.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("thread", threadId);
      url.searchParams.set("acct", accountId);
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* non-browser / blocked — selection still works via state */
    }
  }, []);

  const markRead = useCallback((threadId: string) => {
    setReadIds((prev) => {
      if (prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.add(threadId);
      return next;
    });
  }, []);

  const isSelected = useCallback(
    (threadId: string) => selected?.threadId === threadId,
    [selected]
  );

  const value = useMemo<InboxSplitCtx>(
    () => ({ selected, select, isSelected, readIds, markRead }),
    [selected, select, isSelected, readIds, markRead]
  );

  return (
    <Ctx.Provider value={value}>
      <div className="flex gap-5 items-start">
        {/* List column — own scroll, never unmounts on selection. */}
        <div className="w-[400px] shrink-0 min-w-0 sticky top-3 self-start max-h-[calc(100vh-1.5rem)] overflow-y-auto">
          {children}
        </div>
        <ThreadReadingPane />
      </div>
    </Ctx.Provider>
  );
}
