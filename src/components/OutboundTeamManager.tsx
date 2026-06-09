"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import { PersonAvatar } from "./PersonAvatar";
import { cn } from "@/lib/utils";

// Stand-in storage for the outbound roster. Lives in localStorage so
// the picker works today without a DB migration; the API surface
// (loadTeam / saveTeam) is the seam to swap to Supabase once the team
// formalizes — change those two functions and nothing else.
const STORAGE_KEY = "outbound:team";

function loadTeam(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveTeam(ids: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* localStorage blocked */ }
}

interface OrgUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  departmentIds: string[];
}

export function OutboundTeamManager({ users }: { users: OrgUser[] }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  // Hydrate from localStorage post-mount to avoid the SSR/CSR mismatch
  // that would happen if we initialized the state from localStorage
  // synchronously (server sees an empty set, client sees the cached
  // one, React complains).
  useEffect(() => {
    setSelected(loadTeam());
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveTeam(next);
      return next;
    });
  }

  function clearAll() {
    setSelected(() => {
      saveTeam(new Set());
      return new Set();
    });
  }

  // Filtered + sorted: selected members float to the top, then
  // alphabetical inside each bucket. The search filter is a plain
  // case-insensitive substring match across name + email.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? users.filter(
          (u) =>
            u.name.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q)
        )
      : users.slice();
    rows.sort((a, b) => {
      const sa = selected.has(a.id) ? 0 : 1;
      const sb = selected.has(b.id) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }, [users, query, selected]);

  const selectedUsers = useMemo(
    () => users.filter((u) => selected.has(u.id)),
    [users, selected]
  );

  return (
    <div className="space-y-4">
      {/* Roster header — count + clear all. */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-3 border-b border-slate-100">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
              Current roster
            </div>
            <div className="text-[16px] font-semibold text-ink mt-0.5">
              {selected.size === 0
                ? "No one on the outbound team yet"
                : `${selected.size} ${selected.size === 1 ? "member" : "members"}`}
            </div>
          </div>
          {selected.size > 0 && (
            <button
              onClick={clearAll}
              className="inline-flex items-center gap-1.5 text-[12px] text-ink/60 hover:text-rose-600 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Clear all
            </button>
          )}
        </div>
        {selectedUsers.length > 0 ? (
          <div className="px-5 py-4 flex flex-wrap gap-2">
            {selectedUsers.map((u) => (
              <span
                key={u.id}
                className="inline-flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-full bg-violet-50 border border-violet-200/60 text-[12.5px] text-violet-900"
              >
                <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl ?? undefined} size={20} />
                {u.name}
                <button
                  onClick={() => toggle(u.id)}
                  className="ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded-full hover:bg-violet-200/60 text-violet-700"
                  aria-label={`Remove ${u.name}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <div className="px-5 py-6 text-[13px] text-ink/55">
            Pick people from the list below to staff the outbound team.
          </div>
        )}
      </div>

      {/* Picker — search + scrollable list of org users. */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted z-10" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the org…"
              className="w-full h-10 pl-9 pr-3 rounded-xl bg-slate-50 border border-slate-200 text-[14px] text-ink placeholder:text-muted focus:outline-none focus:bg-white focus:border-accent/50 focus:ring-2 focus:ring-accent/20 transition-colors"
            />
          </div>
        </div>
        <div className="divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-5 py-10 text-center text-[13px] text-ink/55">
              No people match &ldquo;{query}&rdquo;.
            </div>
          )}
          {filtered.map((u) => {
            const on = selected.has(u.id);
            return (
              <button
                key={u.id}
                onClick={() => toggle(u.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-5 py-3 text-left transition-colors",
                  on ? "bg-violet-50/60" : "hover:bg-slate-50"
                )}
              >
                <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl ?? undefined} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium text-ink truncate">{u.name}</div>
                  <div className="text-[12px] text-ink/55 truncate">{u.email}</div>
                </div>
                <div
                  className={cn(
                    "w-7 h-7 rounded-full grid place-items-center transition-colors shrink-0",
                    on
                      ? "bg-violet-600 text-white"
                      : "bg-slate-100 text-ink/40 group-hover:bg-slate-200"
                  )}
                >
                  {on ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
