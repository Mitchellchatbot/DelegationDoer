"use client";

import { useEffect, useState } from "react";
import { Mail, Loader2, AlertCircle, ChevronLeft } from "lucide-react";
import { ThreadConversation, type ThreadDetailData } from "@/components/ThreadConversation";
import { useInboxSplit } from "@/components/InboxSplit";
import { fetchThread, getCachedThread } from "@/lib/thread-cache";
import { useIsMobile } from "@/lib/use-is-mobile";

// The right-hand reading pane in the inbox split view. The selected thread comes
// from InboxSplit's client-local context (NOT the router), so opening a thread
// never re-runs the list's SSR — the list stays mounted with its scroll intact.

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ThreadDetailData };

export function ThreadReadingPane() {
  const { selected, markRead, clearSelection } = useInboxSplit();
  const isMobile = useIsMobile();
  const threadId = selected?.threadId ?? null;
  const accountId = selected?.accountId ?? null;
  const [state, setState] = useState<State>({ status: "idle" });

  useEffect(() => {
    if (!threadId || !accountId) {
      setState({ status: "idle" });
      return;
    }
    const ac = new AbortController();

    // Stale-while-revalidate: if we've already loaded this thread this session
    // (or a hover prefetch resolved it), show it INSTANTLY — no spinner — then
    // refresh in the background. Otherwise show the loading spinner. Either way
    // the fetch is deduped against any in-flight prefetch for the same thread.
    const cached = getCachedThread(threadId, accountId);
    if (cached) {
      setState({ status: "ready", data: cached });
    } else {
      setState({ status: "loading" });
    }

    fetchThread(threadId, accountId, ac.signal)
      .then((data) => {
        setState({ status: "ready", data });
        // Opening = read: flip the list's unread style locally (no SSR refresh).
        markRead(threadId);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // A background revalidation failure shouldn't blow away content we're
        // already showing from cache — only surface errors on a cold open.
        if (cached) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Couldn't load thread"
        });
      });
    return () => ac.abort();
  }, [threadId, accountId, markRead]);

  return (
    <div className="flex-1 min-w-0 sticky top-3 self-start max-h-[calc(100vh-1.5rem)] overflow-y-auto">
      {/* Mobile master-detail back affordance: returns to the full-width list
          (which stayed mounted, so its scroll position is intact). Only shown
          on phones when a thread is open. */}
      {isMobile && selected && (
        <button
          type="button"
          onClick={clearSelection}
          className="sticky top-0 z-10 flex items-center gap-1 w-full px-1 py-2 mb-1 bg-white/90 backdrop-blur-sm text-sm font-medium text-ink/70 hover:text-ink border-b border-slate-100"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
      )}
      {state.status === "idle" && <Empty />}
      {state.status === "loading" && (
        <Centered>
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
        </Centered>
      )}
      {state.status === "error" && (
        <Centered>
          <div className="flex flex-col items-center gap-2 text-center">
            <AlertCircle className="w-6 h-6 text-urgent" />
            <div className="text-sm text-urgent">{state.message}</div>
          </div>
        </Centered>
      )}
      {state.status === "ready" && accountId && threadId && (
        // key forces a fresh mount per thread so mark-read + scroll-to-latest
        // re-fire when switching conversations.
        <ThreadConversation
          key={threadId}
          {...state.data}
          accountId={accountId}
          threadId={threadId}
        />
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid place-items-center min-h-[300px]">{children}</div>;
}

function Empty() {
  return (
    <div className="grid place-items-center min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-14 h-14 rounded-2xl bg-indigo-100 text-indigo-500 grid place-items-center">
          <Mail className="w-7 h-7" />
        </div>
        <div className="text-sm text-ink/55">Select a conversation</div>
      </div>
    </div>
  );
}
