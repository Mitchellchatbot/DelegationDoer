"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Loader2 } from "lucide-react";

// URL-driven filter bar for thread lists. Keeps state in the URL so
// filters are bookmarkable and the page can render server-side from
// `searchParams`. Pushes a new URL on any change, debouncing the search
// box so we don't hammer the API on every keystroke.

const STATUSES = [
  { id: "all",     label: "All" },
  { id: "open",    label: "Open" },
  { id: "pending", label: "Pending" },
  { id: "closed",  label: "Closed" }
] as const;

type StatusId = typeof STATUSES[number]["id"];

export function ThreadFilters({ totalCount }: { totalCount: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const status = (params.get("status") as StatusId) ?? "all";
  const sort = params.get("sort") ?? "recent";
  const initialQ = params.get("q") ?? "";
  const [q, setQ] = useState(initialQ);

  // Reflect URL changes (e.g. back/forward nav) into the input
  useEffect(() => { setQ(initialQ); }, [initialQ]);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    // replace (not push) + `scroll: false` keeps this snappy — the
    // server-rendered thread list is filtered client-side via
    // useSearchParams, so we never need a roundtrip to Missive when
    // the user flicks between Open/Pending/Closed.
    startTransition(() => {
      router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
    });
  }

  // Debounce the search box (350ms) so typing doesn't refetch per keystroke.
  useEffect(() => {
    if (q === initialQ) return;
    const id = setTimeout(() => update({ q: q || null }), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="rounded-2xl border border-white/60 shadow-soft bg-white/70 backdrop-blur-sm p-3 flex items-center gap-2 flex-wrap">
      {/* Status pills */}
      <div className="inline-flex rounded-full bg-slate-100 p-0.5">
        {STATUSES.map((s) => {
          const active = s.id === status;
          return (
            <button
              key={s.id}
              onClick={() => update({ status: s.id === "all" ? null : s.id })}
              className={
                "px-3 py-1 rounded-full text-xs transition-colors " +
                (active
                  ? "bg-white shadow-sm text-ink font-medium"
                  : "text-ink/60 hover:text-ink")
              }
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject or sender…"
          className="pl-8 pr-3 py-1.5 rounded-full bg-white/80 border border-border text-sm w-64 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
        />
      </div>

      {/* Sort */}
      <label className="inline-flex items-center gap-2 text-xs text-muted">
        Sort
        <select
          value={sort}
          onChange={(e) => update({ sort: e.target.value === "recent" ? null : e.target.value })}
          className="rounded-full bg-white/80 border border-border px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          <option value="recent">Most recent</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>

      <div className="ml-auto text-xs text-muted inline-flex items-center gap-1.5">
        {pending && <Loader2 className="w-3 h-3 animate-spin" />}
        <span><span className="font-semibold text-ink tabular-nums">{totalCount}</span> {totalCount === 1 ? "thread" : "threads"}</span>
      </div>
    </div>
  );
}
