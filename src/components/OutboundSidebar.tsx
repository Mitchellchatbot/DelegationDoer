"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  BarChart3, CalendarClock, Linkedin, Users as UsersIcon, ArrowLeft
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { User } from "@/lib/types";

// The outbound dashboard's dedicated sidebar — purple twin of the main
// app's blue sidebar. Lives only inside the (outbound) route group so
// it never co-renders with the main Sidebar. Active row is a faint
// white overlay (same pattern as the main sidebar), and each nav row
// has a saturated colored icon chip so the chrome stays lively against
// the deep purple background.
//
// "Exit dashboard" sits in the footer and routes back to the standard
// blue-sidebar Facebook Ads page — same surface the user came from.

type Tone = "violet" | "fuchsia" | "indigo" | "rose" | "amber" | "sky";

interface NavItem { href: string; label: string; icon: typeof BarChart3; tone: Tone }

const NAV: NavItem[] = [
  { href: "/outbound-dashboard/facebook-ads",   label: "Facebook Ads",   icon: BarChart3,     tone: "indigo"  },
  { href: "/outbound-dashboard/calendly",       label: "Calendly",       icon: CalendarClock, tone: "rose"    },
  { href: "/outbound-dashboard/linkedin-leads", label: "LinkedIn Leads", icon: Linkedin,      tone: "sky"     },
  { href: "/outbound-dashboard/people",         label: "Team",           icon: UsersIcon,     tone: "fuchsia" }
];

const CHIP: Record<Tone, string> = {
  violet:  "bg-violet-400",
  fuchsia: "bg-fuchsia-400",
  indigo:  "bg-indigo-400",
  rose:    "bg-rose-400",
  amber:   "bg-orange-400",
  sky:     "bg-sky-400"
};

export function OutboundSidebar({ user }: { user: User }) {
  const path = usePathname();
  const router = useRouter();

  return (
    <aside
      className="sidebar-panel w-60 shrink-0 sticky top-3 h-[calc(100vh-1.5rem)] rounded-3xl border border-white/10 shadow-lift flex flex-col overflow-hidden text-white"
      style={{
        // Deep purple — twin of the main sidebar's navy but on the
        // opposite end of the wheel. Flat (no gradient) so it reads as
        // a distinct "mode" rather than a variation of the main chrome.
        background: "#3b0764"
      }}
    >
      <div className="px-4 h-16 flex items-center gap-2.5 border-b border-white/15">
        <div className="w-9 h-9 rounded-full overflow-hidden border border-white/40 bg-white shrink-0 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold text-white">Outbound</div>
          <div className="text-[12px] text-purple-200/80">Growth · Sales</div>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2 px-2 py-4 overflow-y-auto">
        <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[10.5px] uppercase tracking-[0.16em] font-semibold text-purple-200/65">
          <span aria-hidden className="w-1 h-1 rounded-full bg-white/80" />
          <span>Channels</span>
        </div>
        <nav className="space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = path === item.href || (item.href !== "/" && path.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-xl text-[15px] transition-all duration-150 active:scale-[0.96] relative",
                  active ? "text-white font-semibold" : "text-white/85 hover:text-white hover:bg-white/5"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="outbound-active-pill"
                    aria-hidden
                    className="absolute inset-0 rounded-xl bg-white/15"
                    transition={{ type: "spring", stiffness: 380, damping: 24 }}
                  />
                )}
                <span className={cn(
                  "relative w-7 h-7 rounded-full grid place-items-center shrink-0 shadow-sm",
                  CHIP[item.tone]
                )}>
                  <Icon className="w-[15px] h-[15px] text-white" />
                </span>
                <span className="relative">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Exit button — leaves the outbound dashboard mode and drops the
          user back on /home inside the main (blue-sidebar) shell. The
          standalone FB Ads page used to live at /outbound/facebook-ads
          but the route was removed; FB Ads now exists only here. */}
      <div className="p-3 border-t border-white/15">
        <button
          onClick={() => router.push("/home")}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm border border-white/20 bg-white/10 text-white hover:bg-white/20 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Exit dashboard
        </button>
        <div className="text-[11px] text-purple-200/60 text-center mt-2">
          signed in as <span className="text-white/85">{user.name}</span>
        </div>
      </div>
    </aside>
  );
}
