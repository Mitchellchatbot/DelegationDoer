"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, ListTodo, Columns3, FolderKanban, Users, ShieldAlert,
  Sparkles, Settings, AlertTriangle, Crown, Mail, Briefcase
} from "lucide-react";
import { useState } from "react";
import { ReportIncidentDialog } from "./ReportIncidentDialog";
import { AIAssistantDrawer } from "./AIAssistantDrawer";
import { RaiseLink } from "./RaiseLink";
import { BackgroundOrbs } from "./BackgroundOrbs";
import { isCEO, isHead } from "@/lib/auth";
import type { User } from "@/lib/types";

// Per-nav-item icon color — kept inside the blue→indigo→violet→purple
// family so the chrome stays tonally unified. Active state is a glassy
// white tile against the sidebar gradient; only the icon hue varies.
type Tone = "blue" | "indigo" | "violet" | "purple";

interface NavItem { href: string; label: string; icon: typeof LayoutDashboard; tone: Tone }

const BASE_NAV: NavItem[] = [
  { href: "/",          label: "Dashboard", icon: LayoutDashboard, tone: "blue" },
  { href: "/my-tasks",  label: "My Tasks",  icon: ListTodo,        tone: "indigo" },
  { href: "/board",     label: "Board",     icon: Columns3,        tone: "violet" },
  { href: "/inboxes",   label: "Inboxes",   icon: Mail,            tone: "purple" },
  { href: "/clients",   label: "Clients",   icon: Briefcase,       tone: "indigo" },
  { href: "/team",      label: "Team",      icon: Users,           tone: "blue" },
  { href: "/incidents", label: "Incidents", icon: ShieldAlert,     tone: "violet" }
];
const CEO_NAV: NavItem[] = [{ href: "/ceo", label: "CEO Console", icon: Crown, tone: "purple" }];
const HEAD_NAV: NavItem[] = [{ href: "/team-overview", label: "Team Overview", icon: Users, tone: "indigo" }];

const TONE_STYLES: Record<Tone, { activeIcon: string; iconIdle: string }> = {
  blue:   { activeIcon: "text-blue-600",   iconIdle: "text-blue-500/70" },
  indigo: { activeIcon: "text-indigo-600", iconIdle: "text-indigo-500/70" },
  violet: { activeIcon: "text-violet-600", iconIdle: "text-violet-500/70" },
  purple: { activeIcon: "text-purple-600", iconIdle: "text-purple-500/70" }
};

export function Sidebar({ user }: { user: User }) {
  const path = usePathname();
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const NAV: NavItem[] = isCEO(user)
    ? [...CEO_NAV, ...BASE_NAV.filter((i) => i.href !== "/")]
    : isHead(user)
      ? [...BASE_NAV.slice(0, 4), ...HEAD_NAV, ...BASE_NAV.slice(4)]
      : BASE_NAV;

  return (
    <aside
      className="w-60 shrink-0 sticky top-3 h-[calc(100vh-1.5rem)] rounded-3xl border border-white/50 shadow-lift flex flex-col overflow-hidden"
      style={{
        background: "linear-gradient(180deg, #DBEAFE 0%, #C7D2FE 35%, #DDD6FE 70%, #E9D5FF 100%)"
      }}
    >
      <BackgroundOrbs variant="sidebar" />

      {/* Brand row — translucent so the gradient + orbs glow through */}
      <div className="relative z-10 px-4 h-14 flex items-center gap-2.5 border-b border-white/40 bg-white/30 backdrop-blur-sm">
        <div className="w-8 h-8 rounded-full overflow-hidden border border-border bg-surface2 shrink-0 ring-2 ring-white/60 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">DelegationDoer</div>
          <div className="text-[11px] text-muted">scaledai.org</div>
        </div>
      </div>

      {/* Vertically centered region: nav floats in the middle of the column,
          with the action buttons just below it. Brand row + footer pin to
          the edges via flex auto-margins on this wrapper. */}
      <div className="relative z-10 flex-1 flex flex-col justify-center gap-2 px-2 py-4">
        <nav className="space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = path === item.href || (item.href !== "/" && path.startsWith(item.href));
            const tone = TONE_STYLES[item.tone];
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm transition-all duration-150 active:scale-[0.98] relative",
                  active
                    ? `bg-white/80 backdrop-blur-sm text-ink font-medium shadow-sm`
                    : `text-ink/65 hover:text-ink hover:bg-white/40`
                )}
              >
                <Icon className={cn("w-4 h-4 shrink-0", active ? tone.activeIcon : tone.iconIdle)} />
                {item.label}
                {active && (
                  <motion.span
                    layoutId="sidebar-active-dot"
                    className={cn("absolute right-2 w-1.5 h-1.5 rounded-full", tone.activeIcon.replace("text-", "bg-"))}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-2 px-1 mt-3">
          <button onClick={() => setIncidentOpen(true)} className="btn-danger w-full justify-center">
            <AlertTriangle className="w-4 h-4" />
            Report incident
          </button>
          <button onClick={() => setAiOpen(true)} className="btn w-full justify-center">
            <Sparkles className="w-4 h-4 text-violet-500" />
            Ask AI <span className="kbd ml-auto">⌘K</span>
          </button>
        </div>
      </div>

      <div className="relative p-3 border-t border-white/40 space-y-2 z-10 bg-white/30 backdrop-blur-sm">
        <Link href="/settings" className="flex items-center gap-2 text-xs text-ink/70 hover:text-ink transition-colors">
          <Settings className="w-3.5 h-3.5" /> Settings
        </Link>
        <RaiseLink />
      </div>

      <ReportIncidentDialog open={incidentOpen} onOpenChange={setIncidentOpen} />
      <AIAssistantDrawer open={aiOpen} onOpenChange={setAiOpen} />
    </aside>
  );
}
