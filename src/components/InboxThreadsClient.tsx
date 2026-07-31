"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Search, Loader2, X, Users, KeyRound, BellRing, Receipt, Calendar, AlertTriangle,
  Inbox, Send, ShieldAlert, FileText, ChevronLeft, ChevronRight, Trash2, BellOff
} from "lucide-react";
import { ThreadList, type ThreadListItem } from "./ThreadList";
import { TrashList, type TrashItem } from "./TrashList";
import { MuteRulesPanel } from "./MuteRulesPanel";
import type { MuteMatchType } from "@/lib/inbox-mute-shared";
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
// TRASH is DD-local too (inbox_thread_deletions): the clone never deletes
// anything, so "deleted" mail is just mail we've been told to hide. It's
// fetched from /api/inboxes/trash and rendered with <TrashList>.
// MUTED is the noise view — real INBOX threads that a workspace mute rule
// caught. It goes through /api/inboxes/threads like any other thread list, just
// with the filter inverted (`muted=only`), so search and paging work normally.
type Folder = "INBOX" | "SENT" | "SPAM" | "DRAFTS" | "TRASH" | "MUTED";

// The two DD-local views. Neither hits /api/inboxes/threads, so the paging,
// search and prefetch machinery below sits them out. MUTED is deliberately NOT
// in here — it's a normal thread list.
const LOCAL_FOLDERS = new Set<Folder>(["DRAFTS", "TRASH"]);

const MAILBOXES: Array<{ id: Folder; label: string; icon: typeof Inbox }> = [
  { id: "INBOX",  label: "Inbox",  icon: Inbox },
  { id: "SENT",   label: "Sent",   icon: Send },
  { id: "DRAFTS", label: "Drafts", icon: FileText },
  { id: "SPAM",   label: "Spam",   icon: ShieldAlert },
  { id: "MUTED",  label: "Muted",  icon: BellOff },
  { id: "TRASH",  label: "Trash",  icon: Trash2 }
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
  // account id → inbox address. Labels the delete picker's checkboxes and the
  // Trash list's "deleted from" chips.
  accountLabelById?: Record<string, string>;
}

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 350;

// The threads API returns "has more", not a total, so we can't render a full
// "1 … N" range up front. Instead the known range grows as the user pages
// forward: each page prefetches the next (revealing whether a further page
// exists), and a page that reports no-more fixes the final count. Given a
// current page and the furthest page known to exist, produce the windowed list
// of page numbers (with "…" gaps) to render.
function pageWindow(current: number, maxKnown: number): Array<number | "…"> {
  const wanted = new Set<number>([1, maxKnown, current - 1, current, current + 1]);
  const nums = [...wanted].filter((p) => p >= 1 && p <= maxKnown).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let prev = 0;
  for (const p of nums) {
    if (prev && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

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
  mailboxId, mailboxIds, initialScopeKey, accountLabelById
}: Props) {
  const [threads, setThreads] = useState<ThreadListItem[]>(initialThreads);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(1);
  // Furthest page we've confirmed exists (grows as pages are fetched/prefetched).
  const [maxKnownPage, setMaxKnownPage] = useState(initialHasMore ? 2 : 1);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [category, setCategory] = useState<Category>("all");
  const [folder, setFolder] = useState<Folder>("INBOX");
  const [drafts, setDrafts] = useState<InboxDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  // Bumped whenever a rule is added or removed, so the Muted view's rule panel
  // refetches without threading a callback through it.
  const [muteRulesVersion, setMuteRulesVersion] = useState(0);
  // The viewer's own id — lets DraftList tell own drafts from others' (in the
  // leader/stealth-admin see-all view). Sourced from the drafts response.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Current page mirrored to a ref so the SSE handler can read it without
  // re-subscribing on every page change.
  const pageRef = useRef(1);
  useEffect(() => { pageRef.current = page; }, [page]);
  // Per-scope page cache (page number → its items + hasMore). Cleared whenever
  // the scope/filter/search changes. Makes Prev/Next and prefetched neighbors
  // instant.
  const pageCacheRef = useRef<Map<number, { items: ThreadListItem[]; hasMore: boolean }>>(new Map());
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

  // Load Trash whenever that view is opened (and after a restore empties a row
  // out of it). Like Drafts this is DD-local — the clone has no trash concept.
  const loadTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const params = new URLSearchParams();
      if (mailboxId) params.set("mailboxId", mailboxId);
      else if (mailboxIdsKey) params.set("mailboxIds", mailboxIdsKey);
      const res = await fetch(`/api/inboxes/trash?${params}`, { cache: "no-store" });
      const data = await res.json();
      setTrash(data.items ?? []);
    } catch {
      setTrash([]);
    } finally {
      setTrashLoading(false);
    }
  }, [mailboxId, mailboxIdsKey]);

  useEffect(() => {
    if (folder !== "TRASH") return;
    void loadTrash();
  }, [folder, loadTrash]);

  // Soft-delete a thread out of the chosen inboxes.
  //
  // The row disappears immediately (with its index remembered) and the request
  // goes out behind it: a delete that only lands after a round-trip feels
  // broken in a mail client. A failure puts the row back exactly where it was
  // and says so; a success offers Undo, which restores the same rows server-side
  // and slots the item back into place.
  const handleDeleteThread = useCallback(async (threadId: string, accountIds: string[]) => {
    const index = threads.findIndex((d) => d.thread.id === threadId);
    if (index === -1) return;
    const item = threads[index];

    const reinsert = () => {
      setThreads((prev) => {
        if (prev.some((d) => d.thread.id === threadId)) return prev;
        const next = [...prev];
        next.splice(Math.min(index, next.length), 0, item);
        return next;
      });
    };
    const drop = () => {
      setThreads((prev) => prev.filter((d) => d.thread.id !== threadId));
    };

    drop();
    // Keep the page cache in step so paging away and back doesn't resurrect it.
    pageCacheRef.current.delete(pageRef.current);

    try {
      const res = await fetch(`/api/inboxes/threads/${encodeURIComponent(threadId)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountIds,
          // Display-only metadata so Trash can render without re-fetching the
          // thread. Sanitized server-side.
          snapshot: {
            subject: item.thread.subject,
            from: item.thread.last_from ?? item.thread.participants?.[0] ?? null,
            snippet: item.thread.last_snippet ?? null,
            last_message_at: item.thread.last_message_at,
            account_emails: (item.thread.account_emails ?? []).map((a) => a.email)
          }
        })
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const deletedFrom: string[] = data.accountIds ?? accountIds;

      toast.success(
        deletedFrom.length > 1
          ? `Deleted from ${deletedFrom.length} inboxes`
          : "Conversation deleted",
        {
          action: {
            label: "Undo",
            onClick: () => {
              reinsert();
              void fetch(`/api/inboxes/threads/${encodeURIComponent(threadId)}/delete`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountIds: deletedFrom })
              })
                .then((r) => { if (!r.ok) throw new Error(); })
                .catch(() => {
                  drop();
                  toast.error("Couldn't undo — the conversation is still in Trash.");
                });
            }
          }
        }
      );
    } catch {
      reinsert();
      toast.error("Couldn't delete that conversation — try again.");
    }
  }, [threads]);

  // Restore from the Trash view. Optimistic like the delete: the row leaves
  // Trash straight away and comes back if the request fails.
  const handleRestore = useCallback(async (item: TrashItem) => {
    setTrash((prev) => prev.filter((t) => t.threadId !== item.threadId));
    try {
      const res = await fetch(`/api/inboxes/threads/${encodeURIComponent(item.threadId)}/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: item.accountIds })
      });
      if (!res.ok) throw new Error();
      toast.success("Conversation restored");
      // It's back in the live list now — drop the cached pages so the next
      // visit to Inbox re-fetches instead of serving a list without it.
      pageCacheRef.current = new Map();
    } catch {
      setTrash((prev) => (prev.some((t) => t.threadId === item.threadId) ? prev : [item, ...prev]));
      toast.error("Couldn't restore that conversation — try again.");
    }
  }, []);

  // Mute a thread's sender. The rule is already saved by the time this runs
  // (MuteSenderControl owns that call), so this is purely the list's reaction:
  // drop the row, and offer an undo that deletes the rule again.
  //
  // Only the clicked thread is removed, not every thread the new rule matches —
  // the rest disappear on the next fetch. Yanking several rows at once on a
  // single click reads as a bug, and the count in the popover already told the
  // user how wide the rule reaches.
  const handleMuteThread = useCallback(async (
    threadId: string,
    rule: { id: string | null; matchType: MuteMatchType; value: string }
  ) => {
    const index = threads.findIndex((d) => d.thread.id === threadId);
    if (index === -1) return;
    const item = threads[index];

    setThreads((prev) => prev.filter((d) => d.thread.id !== threadId));
    pageCacheRef.current.delete(pageRef.current);
    setMuteRulesVersion((v) => v + 1);

    const reinsert = () => {
      setThreads((prev) => {
        if (prev.some((d) => d.thread.id === threadId)) return prev;
        const next = [...prev];
        next.splice(Math.min(index, next.length), 0, item);
        return next;
      });
    };

    // Undo deletes by the id the SERVER returned. This used to re-derive the id
    // from (matchType, value) with a copy of the server's slug rule — two
    // implementations of one scheme, and a DELETE for an id that doesn't exist
    // succeeds silently, so any drift showed up as an undo that claimed to work
    // and left the rule in place. No id (older server) → no Undo button, rather
    // than one that lies.
    const ruleId = rule.id;
    toast.success(
      "Muted — it won't ping or show in the inbox",
      ruleId
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                reinsert();
                void fetch(
                  `/api/inboxes/mute-rules?id=${encodeURIComponent(ruleId)}`,
                  { method: "DELETE" }
                )
                  .then((r) => { if (!r.ok) throw new Error(); })
                  .then(() => setMuteRulesVersion((v) => v + 1))
                  .catch(() => {
                    toast.error("Couldn't undo — remove the rule from the Muted tab.");
                  });
              }
            }
          }
        : undefined
    );
  }, [threads]);

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

    async function refreshFirstPage() {
      // The inbox SSE event signals new *inbound* mail, so it only maps to
      // the Inbox view. Skip while searching, category-filtering, or on the
      // Sent/Spam views so a push can't mutate a list the user is reading — and
      // only when the user is on page 1 (the newest), so a push never yanks the
      // page out from under someone reading further back.
      if (debouncedQ || category !== "all" || folder !== "INBOX") return;
      if (pageRef.current !== 1) return;
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", "0");
        if (mailboxId) params.set("mailboxId", mailboxId);
        else if (mailboxIdsKey) params.set("mailboxIds", mailboxIdsKey);
        const res = await fetch(`/api/inboxes/threads?${params}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const items: ThreadListItem[] = data.threads ?? [];
        pageCacheRef.current.set(1, { items, hasMore: !!data.hasMore });
        setThreads(items);
        setHasMore(!!data.hasMore);
        setMaxKnownPage((m) => Math.max(m, data.hasMore ? 2 : 1));
      } catch { /* network blip — next event tries again */ }
    }

    function open() {
      if (stopped) return;
      try {
        es = new EventSource("/api/inbox-events");
        es.addEventListener("inbox", () => { void refreshFirstPage(); });
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

  // Build the /api/inboxes/threads query for a given 1-based page in the current
  // scope. Search (q) + the mailbox scope are sent server-side, so search always
  // spans the WHOLE scope (every inbox in the selection), never just this page.
  const buildParams = useCallback((pageNum: number) => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String((pageNum - 1) * PAGE_SIZE));
    if (debouncedQ) params.set("q", debouncedQ);
    if (mailboxId) params.set("mailboxId", mailboxId);
    else if (mailboxIdsKey) params.set("mailboxIds", mailboxIdsKey);
    if (category !== "all") params.set("category", category);
    // MUTED isn't a provider folder — it's the INBOX with the mute filter
    // inverted, so send folder=INBOX and flip the filter instead.
    if (folder === "MUTED") params.set("muted", "only");
    else if (folder !== "INBOX") params.set("folder", folder);
    return params;
  }, [debouncedQ, mailboxId, mailboxIdsKey, category, folder]);

  // Warm a page into the cache without touching the visible list, so Prev/Next
  // (and the current page's neighbours) resolve instantly. Also grows
  // maxKnownPage as it discovers further pages exist.
  const prefetchPage = useCallback(async (pageNum: number) => {
    if (pageNum < 1 || LOCAL_FOLDERS.has(folder)) return;
    if (pageCacheRef.current.has(pageNum)) return;
    try {
      const res = await fetch(`/api/inboxes/threads?${buildParams(pageNum)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const items: ThreadListItem[] = data.threads ?? [];
      pageCacheRef.current.set(pageNum, { items, hasMore: !!data.hasMore });
      if (items.length > 0) {
        setMaxKnownPage((m) => Math.max(m, data.hasMore ? pageNum + 1 : pageNum));
      }
    } catch { /* prefetch failures are silent — the real nav will surface them */ }
  }, [buildParams, folder]);

  // Navigate to a page: serve from cache instantly when we have it, else fetch.
  // Warms the neighbours afterward and returns the list to the top.
  const goToPage = useCallback(async (pageNum: number) => {
    if (pageNum < 1 || LOCAL_FOLDERS.has(folder)) return;
    const cached = pageCacheRef.current.get(pageNum);
    if (cached) {
      setThreads(cached.items);
      setHasMore(cached.hasMore);
      setPage(pageNum);
      setMaxKnownPage((m) => Math.max(m, cached.hasMore ? pageNum + 1 : pageNum));
    } else {
      setLoading(true);
      try {
        const res = await fetch(`/api/inboxes/threads?${buildParams(pageNum)}`, { cache: "no-store" });
        const data = await res.json();
        const items: ThreadListItem[] = data.threads ?? [];
        pageCacheRef.current.set(pageNum, { items, hasMore: !!data.hasMore });
        setThreads(items);
        setHasMore(!!data.hasMore);
        setPage(pageNum);
        setMaxKnownPage((m) => Math.max(m, data.hasMore ? pageNum + 1 : pageNum));
      } catch {
        setThreads([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    }
    void prefetchPage(pageNum + 1);
    if (pageNum > 1) void prefetchPage(pageNum - 1);
    rootRef.current?.scrollIntoView({ block: "start" });
  }, [buildParams, folder, prefetchPage]);

  // Reseed to page 1 whenever the scope/filter/search actually changes — NOT on
  // every `initialThreads` identity change (the force-dynamic page hands us a
  // fresh array on any server re-render, e.g. a sibling pane's mark-read; the
  // scopeKey gate keeps our current page stable across those). The default INBOX
  // view with the SSR'd scope seeds page 1 from SSR (no fetch); everything else
  // fetches page 1.
  const scopeKey = `${debouncedQ}|${category}|${folder}|${mailboxId ?? ""}|${mailboxIdsKey}`;
  const scopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (LOCAL_FOLDERS.has(folder)) return;
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    pageCacheRef.current = new Map();
    setPage(1);
    setSearchActive(!!debouncedQ);
    if (isDefaultView && (initialScopeKey === undefined || mailboxIdsKey === initialScopeKey)) {
      pageCacheRef.current.set(1, { items: initialThreads, hasMore: initialHasMore });
      setThreads(initialThreads);
      setHasMore(initialHasMore);
      setMaxKnownPage(initialHasMore ? 2 : 1);
      void prefetchPage(2);
      return;
    }
    void goToPage(1);
  }, [scopeKey, isDefaultView, initialThreads, initialHasMore, initialScopeKey, mailboxIdsKey, debouncedQ, folder, goToPage, prefetchPage]);

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
        : folder === "MUTED"
          ? "Nothing muted in this view. Mute a noisy sender from any row's bell icon."
          : undefined;

  return (
    <div className="space-y-2" ref={rootRef}>
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
      ) : folder === "TRASH" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] text-ink/55">
            <span>Deleted conversations are hidden from the inbox, never removed from the mail server.</span>
            <span className="tabular-nums shrink-0 pl-3">
              {trashLoading
                ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</span>
                : <><span className="font-medium">{trash.length}</span> item{trash.length === 1 ? "" : "s"}</>}
            </span>
          </div>
          <TrashList items={trash} onRestore={handleRestore} />
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
            <>Page <span className="font-medium">{page}</span></>
          ) : (
            <><span className="font-semibold text-accent">{unreadCount}</span> unread</>
          )}
        </div>
      </div>

      {/* The Muted view leads with the rules themselves — the list below is the
          consequence, and someone arriving here usually wants to know (or
          change) WHY things are being filtered. */}
      {folder === "MUTED" && (
        <MuteRulesPanel
          version={muteRulesVersion}
          onChanged={() => {
            setMuteRulesVersion((v) => v + 1);
            pageCacheRef.current = new Map();
            void goToPage(1);
          }}
        />
      )}

      <ThreadList
        threads={visibleThreads}
        linkAccountId={linkAccountId}
        accountIdByEmail={accountIdByEmail}
        missiveAppUrl={missiveAppUrl}
        emptyMessage={emptyMessage}
        // Single-inbox view: delete always targets this inbox, so no picker.
        // Combined views leave it unset and derive the options per thread.
        deleteScopeAccountId={mailboxId}
        accountLabelById={accountLabelById}
        onDeleteThread={handleDeleteThread}
        // No mute action inside the Muted view — it's already muted there.
        onMuteThread={folder === "MUTED" ? undefined : handleMuteThread}
      />

      {/* Numbered pagination. The threads API returns "has more" (not a total),
          so the known range grows as you page forward — Next reveals the next
          number, and a page reporting no-more fixes the final count. Neighbour
          pages are prefetched, so Prev/Next are usually instant. */}
      {(page > 1 || hasMore || maxKnownPage > 1) && (
        <nav className="flex items-center justify-center gap-1 py-3" aria-label="Pagination">
          <button
            type="button"
            onClick={() => { void goToPage(page - 1); }}
            disabled={page <= 1 || loading}
            aria-label="Previous page"
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-white text-ink/65 enabled:hover:text-accent enabled:hover:border-accent/40 disabled:opacity-40 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {pageWindow(page, maxKnownPage).map((p, i) =>
            p === "…" ? (
              <span key={`gap-${i}`} className="px-1 text-ink/40 select-none">…</span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => { void goToPage(p); }}
                aria-current={p === page ? "page" : undefined}
                disabled={loading && p === page}
                className={cn(
                  "min-w-[32px] h-8 px-2 rounded-lg text-[12px] font-medium border tabular-nums transition-colors",
                  p === page
                    ? "bg-accent text-white border-accent"
                    : "bg-white text-ink/70 border-slate-200 hover:text-accent hover:border-accent/40"
                )}
              >
                {p}
              </button>
            )
          )}

          <button
            type="button"
            onClick={() => { void goToPage(page + 1); }}
            disabled={!hasMore || loading}
            aria-label="Next page"
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-white text-ink/65 enabled:hover:text-accent enabled:hover:border-accent/40 disabled:opacity-40 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted ml-1" />}
        </nav>
      )}
      </>
      )}
    </div>
  );
}
