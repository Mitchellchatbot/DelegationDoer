"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  ListTodo, Users,
  Sparkles, Crown, Mail, Home as HomeIcon, Sunrise, Moon, Briefcase
} from "lucide-react";
// Sparkles is reused for both Ask AI and Updates — same icon, different context.
import { useEffect, useState } from "react";
import { AIAssistantDrawer } from "./AIAssistantDrawer";
import { RaiseLink } from "./RaiseLink";
import { SidebarMoreMenu, MoreIcons } from "./SidebarMoreMenu";
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

// Slim primary nav: 4 items always visible. Everything else hides
// inside the More overflow menu below. This is the calm-it-down move
// — workers' eyes used to land on 10+ rows of nav competing for
// attention. The grouping logic for who-sees-Manage-vs-People is
// derived below at render time.
const HOME_ITEM: NavItem = { href: "/home",    label: "Home",    icon: HomeIcon, tone: "sky"     };
const SOD_ITEM: NavItem = { href: "/sod", label: "Start day", icon: Sunrise, tone: "sky" };
const EOD_ITEM: NavItem = { href: "/eod", label: "Wrap day", icon: Moon, tone: "indigo" };
const TASKS_ITEM: NavItem = { href: "/tasks",  label: "Tasks",   icon: ListTodo, tone: "indigo"  };
const INBOXES_ITEM: NavItem = { href: "/inboxes", label: "Inboxes", icon: Mail, tone: "fuchsia" };
const CLIENTS_ITEM: NavItem = { href: "/clients", label: "Clients", icon: Briefcase, tone: "amber" };
const UPDATES_ITEM: NavItem = { href: "/updates", label: "Updates", icon: Sparkles, tone: "fuchsia" };
const PEOPLE_ITEM: NavItem = { href: "/people", label: "People", icon: Users, tone: "indigo"   };
const MANAGE_CEO_ITEM: NavItem = { href: "/leader", label: "Manage", icon: Crown, tone: "amber" };
const MANAGE_HEAD_ITEM: NavItem = { href: "/leader", label: "Manage", icon: Users, tone: "emerald" };

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
  const [aiOpen, setAiOpen] = useState(false);

  // Aggregate "things waiting in /updates" badge. Folds in the open
  // SEO request count (SEO team + leader) and the unseen-project-
  // activity count (leader only) into one red pill next to the
  // Updates nav item, so anything new in /updates lights up the
  // sidebar no matter which sub-tab triggered it.
  const canSeeSeo = isLeader(user) || (user.departmentIds ?? []).includes("dep_seo");
  const canSeeProjectUpdates = isLeader(user);
  const [openSeoCount, setOpenSeoCount] = useState<number | null>(null);
  const [unseenProjects, setUnseenProjects] = useState<number | null>(null);
  // Generic nav badges — at-risk client count (Clients) + EOD-pending
  // count after 5pm (People). Lives behind /api/notifications/badges
  // so a single round-trip refreshes everything.
  // Hydrate badge counts from localStorage on first paint so the
  // sidebar doesn't flash null → count when the API lands. The fetch
  // below still overwrites on success; this just removes the visible
  // pop-in between page navigations.
  function readCached(key: string): number | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(key);
      const n = raw != null ? Number(raw) : null;
      return Number.isFinite(n as number) ? (n as number) : null;
    } catch { return null; }
  }
  const [clientsAtRisk, setClientsAtRisk] = useState<number | null>(null);
  const [peopleEodPending, setPeopleEodPending] = useState<number | null>(null);
  const [approvalsPending, setApprovalsPending] = useState<number | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const [inboxesUnread, setInboxesUnread] = useState<number | null>(null);
  // Routing-review pending count — only fetched for leaders + dept heads
  // since workers can't see the page anyway. Mirrors the approvalsPending
  // pattern so the badge feels consistent.
  const canSeeRoutingReview = isLeader(user) || isHead(user);
  const [routingReviewPending, setRoutingReviewPending] = useState<number | null>(null);
  // Pull the cached counts into state after mount — initializing them
  // synchronously from localStorage caused an SSR/CSR hydration mismatch
  // (server rendered no badge, client rendered the cached count).
  useEffect(() => {
    setClientsAtRisk((v) => v ?? readCached("badge:clientsAtRisk"));
    setPeopleEodPending((v) => v ?? readCached("badge:peopleEod"));
    setApprovalsPending((v) => v ?? readCached("badge:approvals"));
    setInboxesUnread((v) => v ?? readCached("badge:inboxesUnread"));
    setRoutingReviewPending((v) => v ?? readCached("badge:routingReview"));
  }, []);
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
        if (canSeeRoutingReview) {
          // Mirror the approvalsPending pattern: tally the size of the
          // pending bucket from the routing-review feed. Failures fall
          // back to the cached count so the sidebar doesn't flicker.
          const res = await fetch("/api/routing-review", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            const n = Array.isArray(data.pending) ? data.pending.length : 0;
            if (!cancelled) {
              setRoutingReviewPending(n);
              try { window.localStorage.setItem("badge:routingReview", String(n)); }
              catch { /* localStorage blocked */ }
            }
          }
        }
        // Generic badges — same poll cadence; cheap single round-trip.
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
              // Cache for the next first-paint. Persisted per-tab is
              // fine; localStorage stays consistent across reloads.
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
    // pushes a fresh refresh the instant something changes in any
    // inbox the user can see (missiveclone fires a webhook on inbound
    // mail, DD verifies + republishes over /api/inbox-events); the
    // interval is just a safety net for dropped streams.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fetchCounts();
    }, 5 * 60_000);
    const onVis = () => { if (document.visibilityState === "visible") fetchCounts(); };
    document.addEventListener("visibilitychange", onVis);

    // Live push: refresh badges on any inbox event the server decided
    // this user is allowed to see. Server-side per-user cache for
    // /api/notifications/badges is already busted by the webhook
    // receiver, so the refetch reads fresh data.
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    function openStream() {
      if (typeof EventSource === "undefined") return;
      try {
        es = new EventSource("/api/inbox-events");
        es.addEventListener("inbox", () => { if (!cancelled) fetchCounts(); });
        es.onopen = () => { retryAttempt = 0; };
        es.onerror = () => {
          es?.close();
          es = null;
          // Reconnect with capped exponential backoff so a flapping
          // network doesn't hammer the SSE endpoint.
          retryAttempt += 1;
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(retryAttempt, 6));
          retryTimer = setTimeout(() => { if (!cancelled) openStream(); }, delay);
        };
      } catch { /* EventSource unsupported / blocked — polling backstop covers it */ }
    }
    openStream();

    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [canSeeSeo, canSeeProjectUpdates, canSeeRoutingReview]);

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

  // Slim primary nav. 4 items always visible:
  //   1. Home — new landing surface, replaces dashboard + people-as-default
  //   2. Tasks
  //   3. Inboxes
  //   4. Manage (leaders/heads) OR People (workers, who don't get Manage)
  // Then SidebarMoreMenu below renders the overflow popover.
  const canSeeProjects = (user.departmentIds ?? []).includes("dep_software");
  const isLeaderRole = isLeader(user);
  const isHeadRole = isHead(user);

  const manageOrPeople = isLeaderRole
    ? MANAGE_CEO_ITEM
    : isHeadRole
      ? MANAGE_HEAD_ITEM
      : PEOPLE_ITEM;
  // SOD + EOD are first-class daily rituals for anyone who submits
  // them — workers and heads. Leaders + stealth admins are exempt
  // (same as ClockGate), so they don't see the rows. Placed adjacent
  // to each other, right after Home, so they read as a pair.
  const submitsDailies = !isLeaderRole;
  const NAV: NavItem[] = submitsDailies
    ? [HOME_ITEM, SOD_ITEM, EOD_ITEM, TASKS_ITEM, INBOXES_ITEM, CLIENTS_ITEM, UPDATES_ITEM, manageOrPeople]
    : [HOME_ITEM, TASKS_ITEM, INBOXES_ITEM, CLIENTS_ITEM, UPDATES_ITEM, manageOrPeople];

  // Build the More menu groups dynamically so workers don't see
  // approver-only rows and non-software workers don't see Projects.
  // Each item carries its current badge count so the row shows a pill
  // and the More trigger shows a single dot if any nested badge > 0.
  const updatesTotal =
    (canSeeSeo ? (openSeoCount ?? 0) : 0) +
    (canSeeProjectUpdates ? (unseenProjects ?? 0) : 0);
  const moreGroups = [
    {
      label: "My work",
      items: [
        { href: "/schedule", label: "Schedule", icon: MoreIcons.Schedule },
        ...(canSeeProjects ? [{ href: "/projects", label: "Projects", icon: MoreIcons.Projects }] : [])
      ]
    },
    {
      label: "Team",
      items: [
        // People sits in primary for workers; tuck it into More for
        // leaders/heads who have Manage in primary instead.
        ...(isLeaderRole || isHeadRole
          ? [{ href: "/people", label: "People", icon: MoreIcons.People, badge: peopleEodPending ?? 0 }]
          : []),
        // Routing review — leaders/heads only. The auto-intake pipeline's
        // pending bucket. Surfaces here next to People so the leader can
        // triage routing decisions in the same trip.
        ...(canSeeRoutingReview
          ? [{ href: "/routing-review", label: "Routing review", icon: MoreIcons.RoutingReview, badge: routingReviewPending ?? 0 }]
          : []),
        ...(canApprove
          ? [
              { href: "/approvals", label: "Approvals", icon: MoreIcons.Approvals, badge: approvalsPending ?? 0 },
              { href: "/emails", label: "Outbound emails", icon: MoreIcons.OutboundEmails }
            ]
          : [])
      ]
    },
    {
      // Clients + Updates moved into the primary nav, so they no
      // longer appear here — duplicating would just confuse "where
      // do I click?". SOPs stays.
      label: "Knowledge",
      items: [
        { href: "/sops",    label: "SOPs",    icon: MoreIcons.SOPs }
      ]
    },
    {
      label: "System",
      items: [
        { href: "/settings", label: "Settings", icon: MoreIcons.Settings }
      ]
    }
  ].filter((g) => g.items.length > 0);

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
            // Only primary-row badges live here now. Everything else
            // moved into the SidebarMoreMenu, where the row pill is
            // rendered by that component.
            const badge: { count: number; tone: "rose" | "amber"; title: string } | null = (() => {
              if (item.href === "/inboxes" && (inboxesUnread ?? 0) > 0) {
                return {
                  count: inboxesUnread!,
                  tone: "rose",
                  title: `${inboxesUnread} unread thread${inboxesUnread === 1 ? "" : "s"} across your inboxes`
                };
              }
              if (item.href === "/people" && (peopleEodPending ?? 0) > 0) {
                return {
                  count: peopleEodPending!,
                  tone: "amber",
                  title: `${peopleEodPending} EOD ${peopleEodPending === 1 ? "form" : "forms"} not yet submitted today`
                };
              }
              if (item.href === "/clients" && (clientsAtRisk ?? 0) > 0) {
                return {
                  count: clientsAtRisk!,
                  tone: "rose",
                  title: `${clientsAtRisk} ${clientsAtRisk === 1 ? "client is" : "clients are"} at-risk or shaky`
                };
              }
              if (item.href === "/updates" && updatesTotal > 0) {
                return {
                  count: updatesTotal,
                  tone: "rose",
                  title: `${updatesTotal} new update${updatesTotal === 1 ? "" : "s"} waiting`
                };
              }
              // Approvals / Routing review moved into the More popover
              // — their badges render as row pills there, plus a
              // single dot on the More trigger when any nested badge
              // > 0.
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

          {/* Overflow menu — Schedule, Projects, SOPs, Updates, Approvals,
              Outbound emails, Settings, etc. Groupings + role gating
              are baked into moreGroups above. Sits visually as a 5th
              row so the primary nav reads as "5 things". */}
          <SidebarMoreMenu groups={moreGroups} />
        </nav>

        {/* Report incident moved into /settings — too loud to live next
            to the primary nav for something used only a few times a
            month. Ask AI stays here since ⌘K is the universal entry. */}
        <div className="space-y-2 px-1 mt-3">
          <button
            onClick={() => setAiOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm border border-slate-200 bg-white text-ink hover:bg-slate-50 transition-colors"
          >
            <Sparkles className="w-4 h-4 text-fuchsia-500" />
            Ask AI <span className="ml-auto px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-[11px] font-mono text-muted">⌘K</span>
          </button>
        </div>
      </div>

      {/* Footer keeps the raise-money easter egg but Settings moved into
          More → System so it doesn't fight the primary nav for room. */}
      <div className="p-3 border-t border-slate-100">
        <RaiseLink />
      </div>

      <AIAssistantDrawer open={aiOpen} onOpenChange={setAiOpen} />
    </aside>
  );
}
