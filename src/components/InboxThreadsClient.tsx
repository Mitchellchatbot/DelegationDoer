"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2, X } from "lucide-react";
import { ThreadList, type ThreadListItem } from "./ThreadList";
import { cn } from "@/lib/utils";

interface Props {
  initialThreads: ThreadListItem[];
  initialHasMore: boolean;
  linkAccountId: string;
  accountIdByEmail?: Record<string, string>;
  missiveAppUrl?: string;
  // Optional server-side scope. Passed to /api/inboxes/threads so the
  // pagination & search stay scoped to one connected account.
  mailboxId?: string;
}

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 350;

// Client-side wrapper that gives any inbox page server-paginated
// infinite scroll + full-text search. The first page is rendered
// from SSR; subsequent pages stream in via /api/inboxes/threads as
// the user scrolls past the sentinel near the bottom of the list.
//
// Search hits the missive backend's tsvector + ILIKE operators (so
// it covers subject, sender, recipients, AND body content), and
// replaces the visible list when the user types. Clearing the input
// reverts to the initial SSR'd page.
export function InboxThreadsClient({
  initialThreads, initialHasMore, linkAccountId, accountIdByEmail, missiveAppUrl, mailboxId
}: Props) {
  const [threads, setThreads] = useState<ThreadListItem[]>(initialThreads);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Debounce search input — fires once 350ms after the user stops typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Live push: any new message in an account the user can see triggers
  // a refresh of page 0 (the slice the user is actually looking at).
  // Skips while the user is mid-search so the result set doesn't shift
  // under them. EventSource auto-reconnects on most browsers but we
  // also handle onerror with capped backoff to survive proxy hiccups.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    async function refreshPageZero() {
      if (debouncedQ) return;
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", "0");
        if (mailboxId) params.set("mailboxId", mailboxId);
        const res = await fetch(`/api/inboxes/threads?${params}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        setThreads(data.threads ?? []);
        setHasMore(!!data.hasMore);
      } catch { /* network blip — next event tries again */ }
    }

    function open() {
      if (stopped) return;
      try {
        es = new EventSource("/api/inbox-events");
        es.addEventListener("inbox", () => { void refreshPageZero(); });
        es.onopen = () => { attempt = 0; };
        es.onerror = () => {
          es?.close();
          es = null;
          attempt += 1;
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
          retryTimer = setTimeout(open, delay);
        };
      } catch { /* SSE unavailable — fall back to existing behavior */ }
    }
    open();
    return () => {
      stopped = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [debouncedQ, mailboxId]);

  // Whenever the debounced query changes, replace the list. Empty
  // query → restore the SSR'd initial page so no extra fetch happens.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!debouncedQ) {
        setThreads(initialThreads);
        setHasMore(initialHasMore);
        setSearchActive(false);
        return;
      }
      setLoading(true);
      setSearchActive(true);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", "0");
        params.set("q", debouncedQ);
        if (mailboxId) params.set("mailboxId", mailboxId);
        const res = await fetch(`/api/inboxes/threads?${params}`, { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) {
          setThreads(data.threads ?? []);
          setHasMore(!!data.hasMore);
        }
      } catch {
        if (!cancelled) {
          setThreads([]);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [debouncedQ, initialThreads, initialHasMore, mailboxId]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(threads.length));
      if (debouncedQ) params.set("q", debouncedQ);
      if (mailboxId) params.set("mailboxId", mailboxId);
      const res = await fetch(`/api/inboxes/threads?${params}`, { cache: "no-store" });
      const data = await res.json();
      const more: ThreadListItem[] = data.threads ?? [];
      // Dedupe in case a new message bumped a thread between fetches.
      const seen = new Set(threads.map((d) => d.thread.id));
      const append = more.filter((d) => !seen.has(d.thread.id));
      setThreads((prev) => [...prev, ...append]);
      setHasMore(!!data.hasMore);
    } catch {
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [loading, hasMore, threads, debouncedQ, mailboxId]);

  // IntersectionObserver on the sentinel below the list. When it
  // scrolls into view, kick off the next page. Setting rootMargin
  // makes the load fire slightly before the sentinel is fully visible
  // so the page feels seamless instead of stalling at the edge.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void loadMore();
        }
      },
      { rootMargin: "400px 0px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [loadMore]);

  const unreadCount = useMemo(() => threads.filter((d) => d.unread).length, [threads]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted z-10" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject, sender, body…"
          className="w-full rounded-2xl border border-slate-200/70 bg-white pl-10 pr-10 py-2.5 text-[13px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
        />
        {(loading || q) && (
          <div className="absolute right-3.5 top-1/2 -translate-y-1/2 z-10 flex items-center gap-1">
            {loading && <Loader2 className="w-3.5 h-3.5 text-muted animate-spin" />}
            {q && !loading && (
              <button
                type="button"
                onClick={() => setQ("")}
                className="p-0.5 rounded text-muted hover:text-ink"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="text-[11px] text-ink/55 px-1 flex items-center gap-2">
        {searchActive ? (
          <>
            <span className="font-medium">{threads.length}</span> result{threads.length === 1 ? "" : "s"} for &ldquo;{debouncedQ}&rdquo;
          </>
        ) : (
          <>
            <span className="font-semibold text-accent">{unreadCount}</span> unread · loaded {threads.length} thread{threads.length === 1 ? "" : "s"}
          </>
        )}
      </div>

      <ThreadList
        threads={threads}
        linkAccountId={linkAccountId}
        accountIdByEmail={accountIdByEmail}
        missiveAppUrl={missiveAppUrl}
        emptyMessage={searchActive ? "No threads match that search." : undefined}
      />

      {/* Sentinel + load-more indicator. Stays mounted as long as
          there are more pages; observer fires when it scrolls into
          view. Manual click as a fallback for users on environments
          where IntersectionObserver feels stuck (some embedded
          webviews). */}
      {hasMore && (
        <div ref={sentinelRef} className="py-4 text-center">
          <button
            type="button"
            onClick={() => { void loadMore(); }}
            disabled={loading}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border transition-colors",
              loading
                ? "border-slate-200 bg-slate-50 text-ink/45"
                : "border-slate-200 bg-white text-ink/65 hover:text-accent hover:border-accent/40"
            )}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {loading ? "Loading more…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
