"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, Loader2, AlertCircle, ChevronLeft } from "lucide-react";
import { ThreadConversation, type ThreadDetailData } from "@/components/ThreadConversation";
import { useInboxSplit, type ThreadPreview } from "@/components/InboxSplit";
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
  // Bumped to force a re-fetch of the SAME thread without changing threadId
  // (e.g. after sending a reply). threadId/accountId alone can't trigger it —
  // they don't change — and router.refresh() doesn't reach this client-cached
  // pane, so a just-sent reply would otherwise never appear until re-open.
  const [reloadNonce, setReloadNonce] = useState(0);

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
  }, [threadId, accountId, markRead, reloadNonce]);

  // Re-fetch the open thread in place. fetchThread always hits the network, so
  // bumping the nonce re-runs the effect and swaps in fresh data (incl. a
  // just-sent reply) while the cached copy stays on screen — no spinner flash.
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // Live-update the OPEN thread. Until now only the list reacted to the inbox
  // stream (InboxThreadsClient refreshes page 1), so a reply that arrived from
  // Outlook while you were reading the conversation never appeared — you had to
  // switch away and back. The SSE payload carries the thread id, so this
  // reloads only when the event is about the thread actually on screen.
  useEffect(() => {
    if (!threadId) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    function open() {
      if (stopped) return;
      try {
        es = new EventSource("/api/inbox-events");
        es.addEventListener("inbox", (ev) => {
          try {
            const data = JSON.parse((ev as MessageEvent<string>).data) as { thread_id?: string };
            if (data?.thread_id === threadId) reload();
          } catch { /* malformed frame — ignore */ }
        });
        es.onopen = () => { attempt = 0; };
        es.onerror = () => {
          es?.close();
          es = null;
          attempt += 1;
          retryTimer = setTimeout(open, Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
        };
      } catch { /* SSE unavailable — the thread still loads on open */ }
    }
    open();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [threadId, reload]);

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
        // Cold open: if the row handed us a preview, paint the header + a body
        // skeleton immediately so it feels instant. Fall back to a spinner only
        // when we have nothing to show (e.g. a deep-link open with no list row).
        selected?.preview ? (
          <ThreadOpeningSkeleton preview={selected.preview} />
        ) : (
          <Centered>
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </Centered>
        )
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
          onSent={reload}
        />
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid place-items-center min-h-[300px]">{children}</div>;
}

// Instant placeholder shown on a cold open, built purely from the list row's
// data (no fetch). Subject + sender + date land immediately; the body area is a
// shimmer that the real conversation replaces the moment the fetch resolves.
function ThreadOpeningSkeleton({ preview }: { preview: ThreadPreview }) {
  const from = cleanFrom(preview.from);
  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold text-ink leading-snug">
        {preview.subject || "(no subject)"}
      </h2>
      <div className="mt-1 flex items-center gap-2 text-sm text-ink/60">
        {from && <span className="font-medium text-ink/80">{from}</span>}
        {preview.date && <span>· {shortWhen(preview.date)}</span>}
      </div>
      {preview.snippet && (
        <p className="mt-3 text-sm text-ink/70 line-clamp-3">{preview.snippet}</p>
      )}
      <div className="mt-5 space-y-2.5 animate-pulse" aria-hidden>
        <div className="h-3 rounded bg-slate-200/70 w-11/12" />
        <div className="h-3 rounded bg-slate-200/70 w-full" />
        <div className="h-3 rounded bg-slate-200/70 w-4/5" />
        <div className="h-3 rounded bg-slate-200/70 w-10/12" />
        <div className="h-3 rounded bg-slate-200/70 w-2/3" />
      </div>
      <div className="mt-4 flex items-center gap-1.5 text-xs text-ink/40">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading conversation…
      </div>
    </div>
  );
}

// Strip a display name out of `"Name" <addr@host>`; otherwise show as-is.
function cleanFrom(addr: string): string {
  const m = addr.match(/^"?([^<"]+?)"?\s*<[^>]+>$/);
  return (m ? m[1] : addr).trim();
}

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });
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
