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
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { ThreadReadingPane } from "@/components/ThreadReadingPane";
import { useInboxFocus } from "@/components/InboxFocusProvider";
import { useIsMobile } from "@/lib/use-is-mobile";

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

// Lightweight thread summary the list row already has on hand (no fetch). Passed
// through select() so the reading pane can paint a header INSTANTLY on a cold
// open — subject/sender/date show immediately while the full thread loads,
// instead of a bare spinner.
export interface ThreadPreview {
  subject: string;
  from: string;
  snippet?: string | null;
  date?: string | null;
}

interface Selected {
  accountId: string;
  threadId: string;
  preview?: ThreadPreview;
}

interface InboxSplitCtx {
  selected: Selected | null;
  select: (accountId: string, threadId: string, preview?: ThreadPreview) => void;
  // Clear the open thread (mobile "‹ Back": pane → list). Also strips the
  // thread/acct URL params so a refresh doesn't reopen it.
  clearSelection: () => void;
  isSelected: (threadId: string) => boolean;
  // Threads the user has opened this session — used to drop the unread style
  // in the live list without a server round-trip (the pane marks read).
  readIds: Set<string>;
  markRead: (threadId: string) => void;
}

const Ctx = createContext<InboxSplitCtx>({
  selected: null,
  select: () => {},
  clearSelection: () => {},
  isSelected: () => false,
  readIds: new Set(),
  markRead: () => {}
});

export const useInboxSplit = () => useContext(Ctx);

export function InboxSplit({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  // Focus Mode (driven by the reply composer) collapses the thread list so the
  // reading pane — which holds the composer — fills the content area.
  const { focusMode } = useInboxFocus();
  // On phones the split becomes master-detail: one pane at a time. Only used to
  // gate the framer-motion inline widths below (Tailwind can't override those).
  const isMobile = useIsMobile();
  // Hydrate the initial selection from the URL once (supports refresh, bookmarks
  // and the legacy /threads/[id] redirect). Subsequent selections are local.
  const [selected, setSelected] = useState<Selected | null>(() => {
    const threadId = searchParams.get("thread");
    const accountId = searchParams.get("acct");
    return threadId && accountId ? { accountId, threadId } : null;
  });
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());

  const select = useCallback((accountId: string, threadId: string, preview?: ThreadPreview) => {
    setSelected({ accountId, threadId, preview });
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

  const clearSelection = useCallback(() => {
    setSelected(null);
    // Symmetric to select(): drop the deep-link params so a refresh returns to
    // the list, not the (now closed) thread. Same replaceState, no navigation.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("thread");
      url.searchParams.delete("acct");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* non-browser / blocked — state already cleared */
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
    () => ({ selected, select, clearSelection, isSelected, readIds, markRead }),
    [selected, select, clearSelection, isSelected, readIds, markRead]
  );

  return (
    <Ctx.Provider value={value}>
      {/* gap-0 on mobile: only one pane is visible at a time, so the 20px
          gutter (which would otherwise sit past the full-width pane and cause a
          clipped overflow) collapses. md+ keeps the split gutter. */}
      <div className="flex gap-0 md:gap-5 items-start">
        {/* List column — own scroll, never unmounts on selection. In Focus Mode
            (and on mobile when a thread is open) its width/opacity animate to 0
            so the reading pane fills the row; the column stays MOUNTED so its
            scroll + infinite-scroll state is preserved. On mobile with no
            selection it's full-width (master-detail: list, then thread). */}
        <motion.div
          initial={false}
          animate={{
            width: isMobile ? (selected ? 0 : "100%") : (focusMode ? 0 : 400),
            opacity: isMobile && selected ? 0 : (focusMode ? 0 : 1)
          }}
          transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
          className={cn(
            "shrink-0 min-w-0 sticky top-3 self-start max-h-[calc(100vh-1.5rem)] overflow-y-auto overflow-x-hidden",
            (focusMode || (isMobile && selected)) && "pointer-events-none"
          )}
        >
          {children}
        </motion.div>
        <ThreadReadingPane />
      </div>
    </Ctx.Provider>
  );
}
