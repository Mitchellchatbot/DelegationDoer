"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, ListTodo, Columns3, Users, ShieldAlert,
  Sparkles, Settings, AlertTriangle, Crown, Mail, Briefcase, BarChart3, Search,
  Network, Camera
} from "lucide-react";
import { useState } from "react";
import { ReportIncidentDialog } from "./ReportIncidentDialog";
import { AIAssistantDrawer } from "./AIAssistantDrawer";
import { RaiseLink } from "./RaiseLink";
import { isCEO, isHead } from "@/lib/auth";
import type { User } from "@/lib/types";

// White-glass sidebar with colorful nav-item icons. Each item carries its
// own accent hue (blue / indigo / teal / emerald / amber / rose / fuchsia)
// so the chrome reads as clean white with tasteful color splashes rather
// than a single-tone blue wall. Active state is a soft blue-tinted pill
// with the brand accent for the icon and dot.

type Tone = "blue" | "indigo" | "teal" | "emerald" | "amber" | "rose" | "fuchsia" | "sky";

interface NavItem { href: string; label: string; icon: typeof LayoutDashboard; tone: Tone }

const BASE_NAV: NavItem[] = [
  { href: "/org-chart", label: "Org Chart", icon: Network,         tone: "indigo"   },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, tone: "blue"     },
  { href: "/my-tasks",  label: "My Tasks",  icon: ListTodo,        tone: "indigo"   },
  { href: "/board",     label: "Board",     icon: Columns3,        tone: "teal"     },
  { href: "/inboxes",   label: "Inboxes",   icon: Mail,            tone: "fuchsia"  },
  { href: "/clients",     label: "Clients",     icon: Briefcase,   tone: "amber"    },
  { href: "/eod",         label: "EOD",         icon: Sparkles,    tone: "fuchsia"  },
  { href: "/seo-reports", label: "SEO Reports", icon: Search,      tone: "fuchsia"  },
  { href: "/incidents",   label: "Incidents",   icon: ShieldAlert, tone: "rose"     },
  // Moments + Team pinned to the bottom of the base nav by request, so
  // the higher-traffic work surfaces read first.
  { href: "/moments",     label: "Moments",     icon: Camera,      tone: "fuchsia"  },
  { href: "/team",        label: "Team",        icon: Users,       tone: "emerald"  }
];
const CEO_NAV: NavItem[] = [
  { href: "/ceo",       label: "CEO Console", icon: Crown,    tone: "amber" },
  { href: "/analytics", label: "Analytics",   icon: BarChart3, tone: "sky"  }
];
const HEAD_NAV: NavItem[] = [
  { href: "/team-overview", label: "Team Overview", icon: Users,    tone: "emerald" },
  { href: "/analytics",     label: "Analytics",     icon: BarChart3, tone: "sky"    }
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

  // Org Chart (BASE_NAV[0]) is always the very first item — that's the
  // default landing tab for everyone. Role-specific items slot in
  // immediately after.
  const [orgChart, ...rest] = BASE_NAV;
  const NAV: NavItem[] = isCEO(user)
    ? [orgChart, ...CEO_NAV, ...rest]
    : isHead(user)
      ? [orgChart, ...rest.slice(0, 4), ...HEAD_NAV, ...rest.slice(4)]
      : BASE_NAV;

  return (
    <aside className="w-60 shrink-0 sticky top-3 h-[calc(100vh-1.5rem)] rounded-3xl border border-slate-200/70 bg-white/85 backdrop-blur-xl shadow-soft flex flex-col overflow-hidden">
      {/* Brand row */}
      <div className="px-4 h-16 flex items-center gap-2.5 border-b border-slate-100">
        <div className="w-9 h-9 rounded-full overflow-hidden border border-slate-200 shrink-0 ring-2 ring-white shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold text-ink">DelegationDoer</div>
          <div className="text-[12px] text-muted">scaledai.org</div>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2 px-2 py-4 overflow-y-auto">
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
                  "flex items-center gap-3 px-3 py-2.5 rounded-xl text-[15px] transition-all duration-150 active:scale-[0.98] relative",
                  active
                    ? cn(tone.activeBg, tone.activeFg, "font-semibold")
                    : "text-ink/70 hover:text-ink hover:bg-slate-100/70"
                )}
              >
                <Icon className={cn("w-[18px] h-[18px] shrink-0", active ? tone.activeFg : tone.idle)} />
                {item.label}
                {active && (
                  <motion.span
                    layoutId="sidebar-active-dot"
                    className={cn("absolute right-3 w-1.5 h-1.5 rounded-full", tone.activeFg.replace("text-", "bg-"))}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
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
