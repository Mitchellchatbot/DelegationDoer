"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  Search, Plus, LogOut, X, ListTodo, Users as UsersIcon, FolderKanban,
  Loader2, BookOpen
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PersonAvatar } from "./PersonAvatar";
import { NewTaskForm } from "./NewTaskForm";
// EomPill + NotificationsBell removed from the topbar — they were
// crowding the right side and squeezing the user pill. EOM crowning
// still surfaces inline on rec / leaderboard pages; mention / kudos
// notifications still arrive via Slack DM.
import { ROLE_LABELS } from "@/lib/auth";
import { primaryDepartment } from "@/lib/departments";
import { useNeedsClockIn } from "./ClockGate";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface SearchResults {
  tasks: { id: string; title: string; status: string; priority: string; assigneeName: string | null }[];
  users: { id: string; name: string; email: string | null; avatarUrl: string | null }[];
  projects: { id: string; name: string; departmentName: string | null }[];
  sops: { id: string; title: string; sourceFilename: string; mimeType: string; fileUrl: string }[];
}
const EMPTY_RESULTS: SearchResults = { tasks: [], users: [], projects: [], sops: [] };

export function Topbar({ user }: { user: User }) {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  function submitSearch() {
    const q = query.trim();
    if (!q) return;
    setSearchOpen(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  // Debounced live search. We refetch on every keystroke after a 150ms
  // settle so quick typers don't fan out N requests; cancel on
  // unmount/refire via AbortController so the latest query wins even
  // if earlier ones come back out of order.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(EMPTY_RESULTS);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal
        });
        if (!res.ok) {
          setResults(EMPTY_RESULTS);
          return;
        }
        const data = (await res.json()) as SearchResults;
        setResults(data);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults(EMPTY_RESULTS);
      } finally {
        setSearchLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  // Click-outside dismiss so the dropdown disappears when you wander
  // off without forcing the user to press Escape.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!searchWrapRef.current) return;
      if (!searchWrapRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const totalResults =
    results.tasks.length + results.users.length + results.projects.length + results.sops.length;
  const showDropdown = searchOpen && query.trim().length > 0;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <header className="h-16 sticky top-3 z-30 px-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-3xl border border-slate-200/70 bg-white/85 backdrop-blur-xl shadow-soft">
      {/* Left placeholder so the search sits in the dead center of the bar */}
      <div />

      {/* Centered search with live dropdown. Type → debounced query
          to /api/search → results render below the input. Enter on a
          non-empty query navigates to /search?q=… for the full list. */}
      <div
        ref={searchWrapRef}
        className="relative w-[460px] max-w-full justify-self-center"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
        >
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted z-10" />
          {searchLoading && (
            <Loader2 className="w-4 h-4 absolute right-3.5 top-1/2 -translate-y-1/2 text-muted animate-spin z-10" />
          )}
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchOpen(false);
            }}
            className="w-full h-10 pl-10 pr-9 rounded-xl bg-slate-50 border border-slate-200 text-[15px] text-ink placeholder:text-muted focus:outline-none focus:bg-white focus:border-accent/50 focus:ring-2 focus:ring-accent/20 transition-colors"
            placeholder="Search tasks, projects, people…"
          />
        </form>

        {showDropdown && (
          <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 rounded-2xl border border-slate-200 bg-white shadow-[0_20px_50px_-15px_rgba(15,23,42,0.35)] overflow-hidden max-h-[70vh] overflow-y-auto">
            {totalResults === 0 && !searchLoading && (
              <div className="px-4 py-6 text-center text-xs text-ink/55">
                No matches for &ldquo;{query}&rdquo;.
              </div>
            )}

            {results.tasks.length > 0 && (
              <SearchSection icon={<ListTodo className="w-3.5 h-3.5 text-indigo-500" />} label="Tasks" count={results.tasks.length}>
                {results.tasks.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tasks/${t.id}`}
                    onClick={() => setSearchOpen(false)}
                    className="block px-3 py-2 hover:bg-slate-50 transition-colors"
                  >
                    <div className="text-[13px] font-medium text-ink truncate">{t.title}</div>
                    <div className="text-[10px] text-ink/55 mt-0.5 flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100">{t.status}</span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-100">{t.priority}</span>
                      {t.assigneeName && <span>· {t.assigneeName}</span>}
                    </div>
                  </Link>
                ))}
              </SearchSection>
            )}

            {results.users.length > 0 && (
              <SearchSection icon={<UsersIcon className="w-3.5 h-3.5 text-emerald-500" />} label="People" count={results.users.length}>
                {results.users.map((u) => (
                  <Link
                    key={u.id}
                    href={`/team/${u.id}`}
                    onClick={() => setSearchOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 transition-colors"
                  >
                    <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl ?? undefined} size={24} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{u.name}</div>
                      <div className="text-[10px] text-ink/55 truncate">{u.email}</div>
                    </div>
                  </Link>
                ))}
              </SearchSection>
            )}

            {results.projects.length > 0 && (
              <SearchSection icon={<FolderKanban className="w-3.5 h-3.5 text-indigo-500" />} label="Projects" count={results.projects.length}>
                {results.projects.map((p) => (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}`}
                    onClick={() => setSearchOpen(false)}
                    className="block px-3 py-2 hover:bg-slate-50 transition-colors"
                  >
                    <div className="text-[13px] font-medium text-ink truncate">{p.name}</div>
                    {p.departmentName && (
                      <div className="text-[10px] text-ink/55 truncate mt-0.5">{p.departmentName}</div>
                    )}
                  </Link>
                ))}
              </SearchSection>
            )}

            {results.sops.length > 0 && (
              <SearchSection icon={<BookOpen className="w-3.5 h-3.5 text-teal-500" />} label="SOPs" count={results.sops.length}>
                {results.sops.map((s) => (
                  // SOP rows take you to the underlying file (PDF/image
                  // hosted on Supabase Storage). There's no detail view
                  // in v1; if we add one later, swap this to /sops/[id].
                  <a
                    key={s.id}
                    href={s.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setSearchOpen(false)}
                    className="block px-3 py-2 hover:bg-slate-50 transition-colors"
                  >
                    <div className="text-[13px] font-medium text-ink truncate">{s.title}</div>
                    <div className="text-[10px] text-ink/55 truncate mt-0.5">{s.sourceFilename}</div>
                  </a>
                ))}
              </SearchSection>
            )}

            {totalResults > 0 && (
              <button
                type="button"
                onClick={submitSearch}
                className="w-full px-3 py-2 text-[11px] text-accent hover:bg-slate-50 border-t border-slate-100 text-left font-medium"
              >
                See all results for &ldquo;{query}&rdquo; →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Controls — right-aligned */}
      <div className="flex items-center gap-2 justify-self-end">
        <Dialog.Root open={newTaskOpen} onOpenChange={setNewTaskOpen}>
          <NewTaskTrigger />
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 anim-fade-in" />
            {/* Dialog.Content fills the viewport but is pointer-transparent
                except for the inner card. The flex parent + lg:pl-[264px]
                (12px outer p-3 + 240px sidebar + 12px gap) reserves the
                sidebar width on lg+ so the card centers over just the main
                content panel. On narrow viewports the padding drops to 0
                and we center on the viewport. The card itself caps at
                900px and shrinks below that to avoid overflow at any size. */}
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-0 z-50 outline-none pointer-events-none flex items-start justify-center pt-20 px-4 lg:pl-[264px]"
            >
              <div className="pointer-events-auto w-full max-w-[900px] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-3xl border border-white/60 bg-gradient-to-br from-blue-50/90 via-white/95 to-indigo-50/85 backdrop-blur-md shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] anim-fade-in-up">
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/60 sticky top-0 bg-white/70 backdrop-blur-sm z-10">
                  <div>
                    <Dialog.Title className="text-base font-semibold">New task</Dialog.Title>
                    <Dialog.Description className="text-xs text-muted mt-0.5">
                      Stays on this page — fill it in, hit Create, get back to what you were doing.
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      className="w-8 h-8 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-white/70 transition-colors"
                      aria-label="Close"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </div>
                <div className="p-6">
                  <NewTaskForm
                    onCreated={(taskId) => {
                      setNewTaskOpen(false);
                      // Refresh the current route so any list of tasks on
                      // the page re-fetches and includes the new row. Toast
                      // is already raised by the form itself.
                      router.refresh();
                      // Give the user a one-click jump to the new task
                      // without forcing the navigation.
                      toast.message("Task created", {
                        action: {
                          label: "Open",
                          onClick: () => router.push(`/tasks/${taskId}`)
                        }
                      });
                    }}
                    onCancel={() => setNewTaskOpen(false)}
                    hideCancel
                  />
                </div>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        {(() => {
          const dept = user.role !== "leader" ? primaryDepartment(user.departmentIds) : null;
          // Collapse "Department Head" + dept-chip into one compact
          // chip so the pill doesn't stack two visual elements (long
          // role label + dept chip) in a cramped header. Workers see
          // just the dept name. Heads see "<Dept> Head". Leaders see
          // a single amber "Leader" chip with no dept (they're org-
          // wide). Full label still lives in the tooltip.
          const roleSuffix = user.role === "department_head" ? " Head" : "";
          const chipLabel = user.role === "leader"
            ? "Leader"
            : dept
              ? `${dept.label}${roleSuffix}`
              : ROLE_LABELS[user.role];
          const chipClass = user.role === "leader"
            ? "bg-amber-100 text-amber-700 border-amber-200/60"
            : dept
              ? dept.chip
              : "bg-slate-100 text-slate-600 border-slate-200/60";
          return (
            <div
              // shrink-0 keeps the pill from being crushed by flex when
              // the row gets crowded. Right padding collapses to match
              // the left when the text block is hidden so the pill looks
              // like a clean circle around just the avatar at <lg widths.
              className="flex items-center gap-2.5 p-1 lg:pr-3 rounded-full border border-slate-200 bg-slate-50 shrink-0"
              title={`${user.name} · ${ROLE_LABELS[user.role]}${dept ? ` · ${dept.label}` : ""}`}
            >
              <div className={cn("shrink-0", dept ? `rounded-full ring-2 ${dept.ring}` : "")}>
                <PersonAvatar userId={user.id} name={user.name} imageUrl={user.avatarUrl} size={28} />
              </div>
              {/* Name + chip hide on narrow viewports — at small widths
                  the topbar is cramped and the New task button loses
                  room. Tooltip on the pill keeps the info one hover
                  away. Single-row layout (name | chip) instead of the
                  earlier stacked "name / role-text + chip" so the pill
                  stays tight. */}
              <div className="hidden lg:flex items-center gap-2 text-[12px] leading-tight">
                <span className="text-ink font-semibold whitespace-nowrap">{user.name}</span>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] font-medium whitespace-nowrap ${chipClass}`}>
                  {chipLabel}
                </span>
              </div>
            </div>
          );
        })()}
        <button
          onClick={logout}
          title="Log out"
          className="w-10 h-10 rounded-full inline-flex items-center justify-center bg-slate-50 border border-slate-200 text-ink/65 hover:text-ink hover:bg-slate-100 transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

// Topbar's "New task" trigger — disabled with a tooltip when the
// caller hasn't clocked in yet. Server-side enforcement still kicks
// in via POST /api/tasks, but the visual disable keeps the UX clean
// for the common path.
function NewTaskTrigger() {
  const needsClockIn = useNeedsClockIn();
  if (needsClockIn) {
    return (
      <button
        type="button"
        disabled
        title="Clock in first to add a new task."
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[14px] font-medium text-ink/50 bg-slate-200/70 cursor-not-allowed whitespace-nowrap shrink-0"
      >
        <Plus className="w-4 h-4" /> New task
      </button>
    );
  }
  return (
    <Dialog.Trigger asChild>
      <button className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[14px] font-medium text-white bg-accent hover:bg-accent/90 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift whitespace-nowrap shrink-0">
        <Plus className="w-4 h-4" /> New task
      </button>
    </Dialog.Trigger>
  );
}

function SearchSection({
  icon, label, count, children
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink/45 font-semibold">
        {icon}
        {label}
        <span className="text-ink/40 normal-case font-medium">· {count}</span>
      </div>
      {children}
    </div>
  );
}
