"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Search, Loader2, X, Users, KeyRound, BellRing, Receipt, Calendar, AlertTriangle,
  Inbox, Send, ShieldAlert, FileText
} from "lucide-react";
import { ThreadList, type ThreadListItem } from "./ThreadList";
import { useInboxSplit } from "@/components/InboxSplit";
import { DraftList } from "./DraftList";
import type { InboxDraft } from "@/lib/inbox-drafts";
import { cn } from "@/lib/utils";

type Category = "all" | "people" | "codes" | "newsletters" | "receipts" | "calendar" | "bounces";

// Gmail-style mailbox views. INBOX is the default and renders the SSR'd
// first page unchanged; SENT/SPAM switch the server-side `folder` scope on
// every /api/inboxes/threads fetch (which keeps the same per-user
// visibility filter, so no inbox the user can't already see is exposed).
// DRAFTS is DD-local (the inbox_drafts table), not a missive folder — it's
// fetched from /api/inboxes/drafts and rendered with <DraftList>.
type Folder = "INBOX" | "SENT" | "SPAM" | "DRAFTS";

const MAILBOXES: Array<{ id: Folder; label: string; icon: typeof Inbox }> = [
  { id: "INBOX",  label: "Inbox",  icon: Inbox },
  { id: "SENT",   label: "Sent",   icon: Send },
  { id: "DRAFTS", label: "Drafts", icon: FileText },
  { id: "SPAM",   label: "Spam",   icon: ShieldAlert }
];

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
  // Optional multi-inbox scope for the combined "Selected inboxes" view.
  // Serialized to /api/inboxes/threads as `mailboxIds` and intersected with
  // the caller's visible set server-side. `mailboxId` (single) wins if both
  // are somehow passed.
  mailboxIds?: string[];
  // The scope `initialThreads` was SSR-fetched for (sorted-join of the initial
  // mailboxIds). Lets the default-view restore tell "the SSR'd page" apart from
  // "default filters but the live selection changed" so the latter refetches
  // instead of snapping back to a stale SSR page. Undefined for single/all views.
  initialScopeKey?: string;
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
  initialThreads, initialHasMore, linkAccountId, accountIdByEmail, missiveAppUrl,
  mailboxId, mailboxIds, initialScopeKey
}: Props) {
  const [threads, setThreads] = useState<ThreadListItem[]>(initialThreads);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [category, setCategory] = useState<Category>("all");
  const [folder, setFolder] = useState<Folder>("INBOX");
  const [drafts, setDrafts] = useState<InboxDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  // The viewer's own id — lets DraftList tell own drafts from others' (in the
  // leader/stealth-admin see-all view). Sourced from the drafts response.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Threads opened in the reading pane this session — drop their unread style
  // live without a server refresh (see InboxSplit). Empty when not in a split.
  const { readIds } = useInboxSplit();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Stable, order-independent key for the multi-inbox scope. Sorting means a
  // reordered selection doesn't trigger a refetch; using this string (never the
  // array) in effect deps + the filter key avoids identity-driven refetch loops.
  const mailboxIdsKey = useMemo(
    () => (mailboxIds && mailboxIds.length ? [...mailboxIds].sort().join(",") : ""),
    [mailboxIds]
  );

  // Inbox view shows the SSR'd first page; Sent/Spam are always fetched
  // client-side from /api/inboxes/threads with the folder scope applied.
  const isDefaultView = folder === "INBOX" && category === "all" && !debouncedQ;

  // Fetch the caller's drafts when the Drafts view is open. Kept separate
  // from the thread fetch below: drafts are DD-local and never hit the
  // missive threads endpoint.
  useEffect(() => {
    if (folder !== "DRAFTS") return;
    let cancelled = false;
    setDraftsLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/inboxes/drafts", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) {
          setDrafts(data.drafts ?? []);
          setCurrentUserId(data.currentUserId ?? null);
        }
      } catch {
        if (!cancelled) setDrafts([]);
      } finally {
        if (!cancelled) setDraftsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [folder]);

  // Open a compose draft back into the new-message modal. ComposeButton (a
  // sibling on the page header) watches this query param and auto-opens +
  // hydrates from it.
  const openComposeDraft = useCallback((draftId: string) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("composeDraft", draftId);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  // Discard a draft — optimistic removal + DELETE.
  const discardDraft = useCallback(async (draft: InboxDraft) => {
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    const url = draft.threadId
      ? `/api/inboxes/drafts/thread/${encodeURIComponent(draft.threadId)}`
      : `/api/inboxes/drafts/${encodeURIComponent(draft.id)}`;
    try {
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch {
      toast.error("Couldn't discard the draft — refresh and try again.");
    }
  }, []);

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
      // The inbox SSE event signals new *inbound* mail, so it only maps to
      // the Inbox view. Skip while searching, category-filtering, or on the
      // Sent/Spam views so a push can't mutate a list the user is reading.
      if (debouncedQ || category !== "all" || folder !== "INBOX") return;
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", "0");
        if (mailboxId) params.set("mailboxId", mailboxId);
        else if (mailboxIdsKey) params.set("mailboxIds", mailboxIdsKey);
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
  }, [debouncedQ, category, mailboxId, mailboxIdsKey, folder]);

  // Reseed/replace the visible list ONLY when the actual filter/scope changes
  // (search, category, folder, mailbox) — NOT on every `initialThreads` identity
  // change. The list page is force-dynamic, so any server re-render (e.g. a
  // sibling reading-pane's mark-read, or a router.refresh) hands us a fresh
  // `initialThreads` array; without this gate that would reset the default view
  // back to the SSR'd first page and discard every infinite-scroll page + the
  // scroll position. The key gate keeps the loaded list stable across re-renders.
  const filterKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const filterKey = `${debouncedQ}|${category}|${folder}|${mailboxId ?? ""}|${mailboxIdsKey}`;
    if (filterKeyRef.current === filterKey) return;
    filterKeyRef.current = filterKey;
    let cancelled = false;
    async function run() {
      // Drafts are DD-local and fetched by their own effect — never hit the
      // missive threads endpoint for this view.
      if (folder === "DRAFTS") return;
      // Restore SSR'd page only on the default Inbox view — no search, no
      // category filter, INBOX folder. Any other combination is fetched.
      if (isDefaultView && (initialScopeKey === undefined || mailboxIdsKey === initialScopeKey)) {
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
        else if (mailboxIdsKey) params.set("mailboxIds", mailboxIdsKey);
        if (category !== "all") params.set("category", category);
        if (folder !== "INBOX") params.set("folder", folder);
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
  }, [debouncedQ, initialThreads, initialHasMore, mailboxId, mailboxIdsKey, initialScopeKey, category, folder, isDefaultView]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore || folder === "DRAFTS") return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(threads.length));
      if (debouncedQ) params.set("q", debouncedQ);
      if (mailboxId) params.set("mailboxId", mailboxId);
      else if (mailboxIdsKey) params.set("mailboxIds", mailboxIdsKey);
      if (category !== "all") params.set("category", category);
      if (folder !== "INBOX") params.set("folder", folder);
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
  }, [loading, hasMore, threads, debouncedQ, mailboxId, mailboxIdsKey, category, folder]);

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

  // Apply session-local read-state (threads opened in the pane) so their unread
  // style clears immediately, without a server round-trip resetting the list.
  const visibleThreads = useMemo(
    () =>
      readIds.size === 0
        ? threads
        : threads.map((d) =>
            d.unread && readIds.has(d.thread.id) ? { ...d, unread: false } : d
          ),
    [threads, readIds]
  );

  const unreadCount = useMemo(() => visibleThreads.filter((d) => d.unread).length, [visibleThreads]);

  // Empty-state copy. Search wins (it's the most specific intent), then
  // the mailbox view; Inbox keeps ThreadList's default ("No threads yet").
  const emptyMessage = searchActive
    ? "No threads match that search."
    : folder === "SENT"
      ? "No sent messages in this view yet."
      : folder === "SPAM"
        ? "No spam — your junk folder is clean."
        : undefined;

  return (
    <div className="space-y-2">
      {/* Mailbox views — Gmail-style Inbox / Sent / Spam switcher. This is
          the primary navigation for the list below; search + category
          chips compose *within* the selected mailbox. Switching keeps the
          current search/category so the user stays in context. */}
      <div className="flex items-center gap-1 p-0.5 rounded-xl bg-slate-100/70 border border-slate-200/70 w-fit">
        {MAILBOXES.map((m) => {
          const Icon = m.icon;
          const active = folder === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setFolder(m.id)}
              aria-pressed={active}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all active:scale-[0.97]",
                active
                  ? "bg-white text-accent shadow-soft ring-1 ring-accent/20"
                  : "text-ink/60 hover:text-ink"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {m.label}
            </button>
          );
        })}
      </div>

      {folder === "DRAFTS" ? (
        <div className="space-y-2">
          <div className="flex justify-end text-[11px] text-ink/55 tabular-nums">
            {draftsLoading
              ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</span>
              : <><span className="font-medium">{drafts.length}</span> draft{drafts.length === 1 ? "" : "s"}</>}
          </div>
          <DraftList
            drafts={drafts}
            linkAccountId={linkAccountId}
            currentUserId={currentUserId}
            onOpenCompose={openComposeDraft}
            onDiscard={discardDraft}
          />
        </div>
      ) : (
      <>
      {/* Search + status line — search is what users reach for first;
          categories sit just below as a secondary filter row. Tighter
          rhythm (space-y-2, smaller padding) since this used to take
          ~180px of vertical chrome before the actual list. */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted z-10" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject, sender, recipients…"
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
        threads={visibleThreads}
        linkAccountId={linkAccountId}
        accountIdByEmail={accountIdByEmail}
        missiveAppUrl={missiveAppUrl}
        emptyMessage={emptyMessage}
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
      </>
      )}
    </div>
  );
}
