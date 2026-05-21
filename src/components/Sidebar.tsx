"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  ListTodo, Users,
  Sparkles, Settings, AlertTriangle, Crown, Mail, Briefcase,
  FolderKanban, CalendarDays, BookOpen, LayoutDashboard, ClipboardCheck
} from "lucide-react";
import { useEffect, useState } from "react";
import { ReportIncidentDialog } from "./ReportIncidentDialog";
import { AIAssistantDrawer } from "./AIAssistantDrawer";
import { RaiseLink } from "./RaiseLink";
import { isLeader, isHead } from "@/lib/auth";
import { primaryDepartment } from "@/lib/departments";
import type { User } from "@/lib/types";

// White-glass sidebar with colorful nav-item icons. Each item carries its
// own accent hue (blue / indigo / teal / emerald / amber / rose / fuchsia)
// so the chrome reads as clean white with tasteful color splashes rather
// than a single-tone blue wall. Active state is a soft blue-tinted pill
// with the brand accent for the icon and dot.

type Tone = "blue" | "indigo" | "teal" | "emerald" | "amber" | "rose" | "fuchsia" | "sky";

interface NavItem { href: string; label: string; icon: typeof ListTodo; tone: Tone }

// Projects is software-team-only (+ leader); it gets spliced in
// conditionally below rather than living in the base list.
const BASE_NAV: NavItem[] = [
  // People stays at index 0 — every downstream layout calc treats it
  // as the anchor. Dashboard slots in at index 1 so the worker's 2x2
  // overview lives one click from anywhere without disturbing the
  // existing splice math for the Projects / Manage insertions.
  { href: "/people",    label: "People",    icon: Users,           tone: "indigo"   },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, tone: "blue"     },
  { href: "/tasks",     label: "Tasks",     icon: ListTodo,        tone: "indigo"   },
  { href: "/schedule",  label: "Schedule",  icon: CalendarDays,    tone: "sky"      },
  { href: "/inboxes",   label: "Inboxes",   icon: Mail,            tone: "fuchsia"  },
  { href: "/clients",   label: "Clients",   icon: Briefcase,       tone: "amber"    },
  { href: "/sops",      label: "SOPs",      icon: BookOpen,        tone: "teal"     },
  { href: "/updates",   label: "Updates",   icon: Sparkles,        tone: "fuchsia"  }
];
const CEO_NAV: NavItem[] = [
  { href: "/leader", label: "Manage", icon: Crown, tone: "amber" }
];
const HEAD_NAV: NavItem[] = [
  { href: "/leader", label: "Manage", icon: Users, tone: "emerald" }
];

const TONE_STYLES: Record<Tone, { idle: string; activeBg: string; activeFg: string }> = {
  blue:    { idle: "text-blue-500",    activeBg: "bg-blue-50",    activeFg: "text-blue-600"    },
  indigo:  { idle: "text-indigo-500",  activeBg: "bg-indigo-50",  activeFg: "text-indigo-600"  },
  teal:    { idle: "text-teal-500",    activeBg: "bg-teal-50",    activeFg: "text-teal-600"    },
  emerald: { idle: "text-emerald-500", activeBg: "bg-emerald-50", activeFg: "text-emerald-600" },
  amber:   { idle: "text-amber-500",   activeBg: "bg-amber-50",   activeFg: "text-amber-600"   },
  rose:    { idle: "text-rose-500",    activeBg: "bg-rose-50",    activeFg: "text-rose-600"    },
  fuchsia: { idle: "text-fuchsia-500", activeBg: "bg-fuchsia-50", activeFg: "text-fuchsia-600" },
  sky:     { idle: "text-sky-500",     activeBg: "bg-sky-50",     activeFg: "text-sky-600"     }
};

export function Sidebar({ user }: { user: User }) {
  const path = usePathname();
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  // Sidebar badges break into two flavours:
  //   1. Two role-gated counts (SEO requests, unseen project activity)
  //      that fold into one Updates pill — these have their own per-
  //      sidebar endpoints.
  //   2. The generic notifications/badges feed (clients-at-risk,
  //      EOD-pending after 5pm, pending approvals, inbox unread). One
  //      cheap round-trip refreshes them all. The DD missive-webhook
  //      busts that endpoint's cache so we don't need to poll hard.
  const canSeeSeo = isLeader(user) || (user.departmentIds ?? []).includes("dep_seo");
  const canSeeProjectUpdates = isLeader(user);
  const [openSeoCount, setOpenSeoCount] = useState<number | null>(null);
  const [unseenProjects, setUnseenProjects] = useState<number | null>(null);

  // Hydrate the generic badge counts from localStorage on first paint so
  // the sidebar doesn't flash null→count when the API lands. Each fetch
  // overwrites the cache so the next page navigation also starts hot.
  function readCached(key: string): number | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(key);
      const n = raw != null ? Number(raw) : null;
      return Number.isFinite(n as number) ? (n as number) : null;
    } catch { return null; }
  }
  const [clientsAtRisk, setClientsAtRisk]       = useState<number | null>(() => readCached("badge:clientsAtRisk"));
  const [peopleEodPending, setPeopleEodPending] = useState<number | null>(() => readCached("badge:peopleEod"));
  const [approvalsPending, setApprovalsPending] = useState<number | null>(() => readCached("badge:approvals"));
  const [inboxesUnread, setInboxesUnread]       = useState<number | null>(() => readCached("badge:inboxesUnread"));
  const [canApprove, setCanApprove] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchCounts() {
      try {
        if (canSeeSeo) {
          const res = await fetch("/api/seo-reports/summary", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) setOpenSeoCount(data.openCount ?? 0);
          }
        }
        if (canSeeProjectUpdates) {
          const res = await fetch("/api/projects/updates?limit=1", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) setUnseenProjects(data.unseenCount ?? 0);
          }
        }
        const badgeRes = await fetch("/api/notifications/badges", { cache: "no-store" });
        if (badgeRes.ok) {
          const data = await badgeRes.json();
          if (!cancelled) {
            const c = data.clients ?? 0;
            const e = data.peopleEodPending ?? 0;
            const a = data.approvalsPending ?? 0;
            const i = data.inboxesUnread ?? 0;
            setClientsAtRisk(c);
            setPeopleEodPending(e);
            setApprovalsPending(a);
            setInboxesUnread(i);
            setCanApprove(!!data.canApprove);
            try {
              window.localStorage.setItem("badge:clientsAtRisk", String(c));
              window.localStorage.setItem("badge:peopleEod", String(e));
              window.localStorage.setItem("badge:approvals", String(a));
              window.localStorage.setItem("badge:inboxesUnread", String(i));
            } catch { /* localStorage blocked */ }
          }
        }
      } catch { /* ignore */ }
    }
    fetchCounts();
    // Drop the poll cadence from 30s → 5m. The SSE subscription below
    // pushes a fresh refresh the instant something changes; the
    // interval is just a safety net for dropped streams.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fetchCounts();
    }, 5 * 60_000);
    const onVis = () => { if (document.visibilityState === "visible") fetchCounts(); };
    document.addEventListener("visibilitychange", onVis);

    // Live push: any inbox event triggers a fresh badge fetch. The
    // server-side cache for this user was already busted by the
    // webhook receiver, so the refetch reads fresh data.
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    function openStream() {
      try {
        es = new EventSource("/api/inbox-events");
        es.addEventListener("message", () => { if (!cancelled) fetchCounts(); });
        es.addEventListener("inbox", () => { if (!cancelled) fetchCounts(); });
        es.onerror = () => {
          es?.close();
          es = null;
          // Reconnect with capped exponential backoff so a flapping
          // network doesn't hammer the SSE endpoint.
          retryAttempt += 1;
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(retryAttempt, 6));
          retryTimer = setTimeout(() => { if (!cancelled) openStream(); }, delay);
        };
        es.onopen = () => { retryAttempt = 0; };
      } catch { /* EventSource unsupported / blocked */ }
    }
    openStream();

    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [canSeeSeo, canSeeProjectUpdates]);

  // ⌘K / Ctrl+K opens the Ask AI drawer — wires up the hint shown on
  // the button. Suppressed when the user is mid-edit (so it doesn't
  // hijack the shortcut for text fields that legitimately want it).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setAiOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // People (BASE_NAV[0]) is always the very first item — that's the
  // default landing tab for everyone. Role-specific items slot in
  // immediately after.
  const [people, ...rest] = BASE_NAV;
  // Projects is restricted to leaders and members of the software dept.
  // It sits between Board and Inboxes in the regular flow.
  const canSeeProjects = (user.departmentIds ?? []).includes("dep_software");
  const PROJECTS_ITEM: NavItem = {
    href: "/projects",
    label: "Projects",
    icon: FolderKanban,
    tone: "indigo"
  };
  let restWithExtras = canSeeProjects
    ? [...rest.slice(0, 3), PROJECTS_ITEM, ...rest.slice(3)]
    : rest;
  // Approvals slots right after Inboxes for users who can approve drafts,
  // close to where they'd triage client comms anyway.
  const APPROVALS_ITEM: NavItem = {
    href: "/approvals",
    label: "Approvals",
    icon: ClipboardCheck,
    tone: "emerald"
  };
  if (canApprove) {
    const inboxIdx = restWithExtras.findIndex((i) => i.href === "/inboxes");
    const insertAt = inboxIdx >= 0 ? inboxIdx + 1 : restWithExtras.length;
    restWithExtras = [
      ...restWithExtras.slice(0, insertAt),
      APPROVALS_ITEM,
      ...restWithExtras.slice(insertAt)
    ];
  }
  const restWithProjects = restWithExtras;
  const NAV: NavItem[] = isLeader(user)
    ? [people, ...CEO_NAV, ...restWithProjects]
    : isHead(user)
      ? [
          people,
          ...restWithProjects.slice(0, 4),
          ...HEAD_NAV,
          ...restWithProjects.slice(4)
        ]
      : [people, ...restWithProjects];

  return (
    <aside className="w-60 shrink-0 sticky top-3 h-[calc(100vh-1.5rem)] rounded-3xl border border-slate-200/70 bg-white/85 backdrop-blur-xl shadow-soft flex flex-col overflow-hidden">
      {/* Brand row — the logo's ring picks up the user's department tint
          so each team feels at home in their own corner of the app. */}
      {(() => {
        const dept = !isLeader(user) ? primaryDepartment(user.departmentIds) : null;
        const ringClass = dept ? `ring-2 ${dept.ring}` : "ring-2 ring-white";
        return (
          <div className="px-4 h-16 flex items-center gap-2.5 border-b border-slate-100">
            <div className={cn("w-9 h-9 rounded-full overflow-hidden border border-slate-200 shrink-0 shadow-sm", ringClass)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" />
            </div>
            <div className="leading-tight">
              <div className="text-base font-semibold text-ink">DelegationDoer</div>
              <div className="text-[12px] text-muted">scaledai.org</div>
            </div>
          </div>
        );
      })()}

      <div className="flex-1 flex flex-col gap-2 px-2 py-4 overflow-y-auto">
        <nav className="space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = path === item.href || (item.href !== "/" && path.startsWith(item.href));
            const tone = TONE_STYLES[item.tone];
            const updatesTotal =
              (canSeeSeo ? (openSeoCount ?? 0) : 0) +
              (canSeeProjectUpdates ? (unseenProjects ?? 0) : 0);
            // One red (or amber) pill per row. Source depends on which
            // nav item this is — empty when nothing's pending.
            const badge: { count: number; tone: "rose" | "amber"; title: string } | null = (() => {
              if (item.href === "/updates" && updatesTotal > 0) {
                return { count: updatesTotal, tone: "rose", title: `${updatesTotal} open SEO ${updatesTotal === 1 ? "request" : "requests"}` };
              }
              if (item.href === "/clients" && (clientsAtRisk ?? 0) > 0) {
                return {
                  count: clientsAtRisk!,
                  tone: "rose",
                  title: `${clientsAtRisk} ${clientsAtRisk === 1 ? "client is" : "clients are"} at-risk or shaky`
                };
              }
              if (item.href === "/people" && (peopleEodPending ?? 0) > 0) {
                return {
                  count: peopleEodPending!,
                  tone: "amber",
                  title: `${peopleEodPending} EOD ${peopleEodPending === 1 ? "form" : "forms"} not yet submitted today`
                };
              }
              if (item.href === "/approvals" && (approvalsPending ?? 0) > 0) {
                return {
                  count: approvalsPending!,
                  tone: "rose",
                  title: `${approvalsPending} email${approvalsPending === 1 ? "" : "s"} awaiting your approval`
                };
              }
              if (item.href === "/inboxes" && (inboxesUnread ?? 0) > 0) {
                return {
                  count: inboxesUnread!,
                  tone: "rose",
                  title: `${inboxesUnread} unread thread${inboxesUnread === 1 ? "" : "s"} across your inboxes`
                };
              }
              return null;
            })();
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  // active:scale-[0.96] gives a tactile press feedback on
                  // every click — happens even when re-clicking the
                  // already-active tab, so the row always responds.
                  "flex items-center gap-3 px-3 py-2.5 rounded-xl text-[15px] transition-all duration-150 active:scale-[0.96] relative",
                  // No activeBg here — the sliding pill (below) paints
                  // the active background instead, so the color visibly
                  // glides between tabs on click. activeFg still applies
                  // for text + icon tint.
                  active
                    ? cn(tone.activeFg, "font-semibold")
                    : "text-ink/70 hover:text-ink hover:bg-slate-100/70"
                )}
              >
                {/* Shared active-pill underlay — slides smoothly between
                    tabs on click because every active instance shares
                    the same layoutId. Replaces the static activeBg fill
                    so the color actually animates between tabs. */}
                {active && (
                  <motion.span
                    layoutId="sidebar-active-pill"
                    aria-hidden
                    className={cn("absolute inset-0 rounded-xl", tone.activeBg)}
                    transition={{ type: "spring", stiffness: 380, damping: 24 }}
                  />
                )}
                <Icon className={cn("w-[18px] h-[18px] shrink-0 relative", active ? tone.activeFg : tone.idle)} />
                <span className="relative">{item.label}</span>
                {badge && (
                  <span
                    className={cn(
                      "ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold tabular-nums text-white shadow-sm ring-2 ring-white relative",
                      badge.tone === "rose" ? "bg-rose-500" : "bg-amber-500"
                    )}
                    title={badge.title}
                  >
                    {badge.count}
                  </span>
                )}
                {/* Active-indicator dot. Bumped to 2x2 and a bouncier
                    spring so the slide between tabs reads as a real
                    motion rather than a snap. layoutId is shared
                    across every nav item, so Framer Motion animates
                    the same DOM dot from its old position to its new
                    one on every tab change. */}
                {active && !badge && (
                  <motion.span
                    layoutId="sidebar-active-dot"
                    aria-hidden
                    className={cn("absolute right-3 w-2 h-2 rounded-full shadow-sm", tone.activeFg.replace("text-", "bg-"))}
                    transition={{ type: "spring", stiffness: 380, damping: 22 }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-2 px-1 mt-3">
          <button
            onClick={() => setIncidentOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 transition-colors"
          >
            <AlertTriangle className="w-4 h-4" />
            Report incident
          </button>
          <button
            onClick={() => setAiOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm border border-slate-200 bg-white text-ink hover:bg-slate-50 transition-colors"
          >
            <Sparkles className="w-4 h-4 text-fuchsia-500" />
            Ask AI <span className="ml-auto px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-[11px] font-mono text-muted">⌘K</span>
          </button>
        </div>
      </div>

      <div className="p-3 border-t border-slate-100 space-y-2">
        <Link href="/settings" className="flex items-center gap-2 text-sm text-ink/70 hover:text-ink transition-colors">
          <Settings className="w-4 h-4" /> Settings
        </Link>
        <RaiseLink />
      </div>

      <ReportIncidentDialog open={incidentOpen} onOpenChange={setIncidentOpen} />
      <AIAssistantDrawer open={aiOpen} onOpenChange={setAiOpen} />
    </aside>
  );
}
