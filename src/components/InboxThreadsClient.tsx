"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Loader2, X, Users, KeyRound, BellRing, Receipt, Calendar, AlertTriangle, Inbox
} from "lucide-react";
import { ThreadList, type ThreadListItem } from "./ThreadList";
import { cn } from "@/lib/utils";

type Category = "all" | "people" | "codes" | "newsletters" | "receipts" | "calendar" | "bounces";

const CATEGORIES: Array<{ id: Category; label: string; icon: typeof Users; tone: string }> = [
  { id: "all",         label: "All",          icon: Inbox,          tone: "text-ink/65" },
  { id: "people",      label: "People",       icon: Users,          tone: "text-emerald-600" },
  { id: "codes",       label: "Codes",        icon: KeyRound,       tone: "text-rose-600" },
  { id: "newsletters", label: "Newsletters",  icon: BellRing,       tone: "text-amber-600" },
  { id: "receipts",    label: "Receipts",     icon: Receipt,        tone: "text-emerald-700" },
  { id: "calendar",    label: "Calendar",     icon: Calendar,       tone: "text-violet-600" },
  { id: "bounces",     label: "Bounces",      icon: AlertTriangle,  tone: "text-rose-700" }
];

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
  const [category, setCategory] = useState<Category>("all");
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Debounce search input — fires once 350ms after the user stops typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Live push from missiveclone → DD → SSE: any new message in an
  // account the user can see triggers a refresh of page 0 (the slice
  // currently on screen). Skipped while the user is mid-search or
  // mid-category-filter so a surprise list mutation doesn't break their
  // flow. EventSource auto-reconnects on most browsers; the manual
  // onerror handler covers proxy/network hiccups with capped backoff.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    async function refreshPageZero() {
      if (debouncedQ || category !== "all") return;
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
  }, [debouncedQ, category, mailboxId]);

  // Whenever the debounced query changes, replace the list. Empty
  // query → restore the SSR'd initial page so no extra fetch happens.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      // Restore SSR'd page only when there's nothing to override —
      // no search and no category filter applied.
      if (!debouncedQ && category === "all") {
        setThreads(initialThreads);
        setHasMore(initialHasMore);
        setSearchActive(false);
        return;
      }
      setLoading(true);
      setSearchActive(!!debouncedQ);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", "0");
        if (debouncedQ) params.set("q", debouncedQ);
        if (mailboxId) params.set("mailboxId", mailboxId);
        if (category !== "all") params.set("category", category);
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
  }, [debouncedQ, initialThreads, initialHasMore, mailboxId, category]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(threads.length));
      if (debouncedQ) params.set("q", debouncedQ);
      if (mailboxId) params.set("mailboxId", mailboxId);
      if (category !== "all") params.set("category", category);
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
  }, [loading, hasMore, threads, debouncedQ, mailboxId, category]);

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
    <div className="space-y-2">
      {/* Search + status line on top — search is what users reach for
          first; categories sit just below as a secondary filter row.
          Tighter rhythm (space-y-2, smaller padding) since this used
          to take ~180px of vertical chrome before the actual list. */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted z-10" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject, sender, body…"
          className="w-full rounded-xl border border-slate-200/70 bg-white pl-9 pr-9 py-2 text-[13px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
        />
        {(loading || q) && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 z-10 flex items-center gap-1">
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

      {/* Category chips + stat line on a single row. Categories live
          in a horizontal scroller (still works on narrow widths) and
          the unread/result count sits at the right edge where the eye
          lands after scanning the chips. Same buckets missiveclone's
          left rail uses; "People" hides automated senders. */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 flex-1 min-w-0 no-scrollbar">
          {CATEGORIES.map((c) => {
            const Icon = c.icon;
            const active = category === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border whitespace-nowrap transition-all active:scale-[0.97]",
                  active
                    ? "bg-accent/10 text-accent border-accent/40"
                    : "bg-white text-ink/65 border-slate-200 hover:border-accent/30 hover:text-ink"
                )}
              >
                <Icon className={cn("w-3 h-3", active ? "text-accent" : c.tone)} />
                {c.label}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-ink/55 tabular-nums whitespace-nowrap shrink-0">
          {searchActive ? (
            <><span className="font-medium">{threads.length}</span> result{threads.length === 1 ? "" : "s"}</>
          ) : (
            <><span className="font-semibold text-accent">{unreadCount}</span> unread</>
          )}
        </div>
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
