"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  BarChart3, CalendarClock, Globe, Linkedin, Users as UsersIcon, ArrowLeft,
  MessageSquare, Flame
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { User } from "@/lib/types";

// The outbound dashboard's dedicated sidebar — a clean, light panel that
// reads as a premium, enterprise surface. Lives only inside the
// (outbound) route group so it never co-renders with the main Sidebar.
// The active row is a faint slate pill (same pattern as the main
// sidebar), and each nav row has a restrained monochrome icon chip; the
// active row's chip picks up the brand accent.
//
// "Exit dashboard" sits in the footer and routes back to the standard
// blue-sidebar home — same surface the user came from.

interface NavItem { href: string; label: string; icon: typeof BarChart3 }

const NAV: NavItem[] = [
  { href: "/outbound-dashboard/leads",           label: "Leads",              icon: Flame         },
  { href: "/outbound-dashboard/templates",       label: "Templates",          icon: MessageSquare },
  { href: "/outbound-dashboard/facebook-ads",    label: "Mike's Facebook Campaign", icon: BarChart3 },
  { href: "/outbound-dashboard/calendly",        label: "Calendly",           icon: CalendarClock },
  { href: "/outbound-dashboard/messaging",       label: "Outbound messaging", icon: MessageSquare },
  { href: "/outbound-dashboard/linkedin-leads",  label: "LinkedIn Leads",     icon: Linkedin      },
  { href: "/outbound-dashboard/website-builder", label: "Website Builder",    icon: Globe         },
  { href: "/outbound-dashboard/people",          label: "Team",               icon: UsersIcon     }
];

export function OutboundSidebar({ user }: { user: User }) {
  const path = usePathname();
  const router = useRouter();

  return (
    <aside className="sidebar-panel w-60 shrink-0 sticky top-3 h-[calc(100vh-1.5rem)] rounded-2xl border border-slate-200 bg-white shadow-soft flex flex-col overflow-hidden text-ink">
      <div className="px-4 h-16 flex items-center gap-2.5 border-b border-slate-100">
        <div className="w-9 h-9 rounded-full overflow-hidden border border-slate-200 bg-white shrink-0 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold text-ink">Outbound</div>
          <div className="text-[12px] text-ink/50">Growth · Sales</div>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2 px-2 py-4 overflow-y-auto">
        <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[10.5px] uppercase tracking-[0.16em] font-semibold text-ink/40">
          <span aria-hidden className="w-1 h-1 rounded-full bg-ink/25" />
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
                  active ? "text-ink font-semibold" : "text-ink/70 hover:text-ink hover:bg-slate-50"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="outbound-active-pill"
                    aria-hidden
                    className="absolute inset-0 rounded-xl bg-slate-100"
                    transition={{ type: "spring", stiffness: 380, damping: 24 }}
                  />
                )}
                <span className={cn(
                  "relative w-7 h-7 rounded-lg grid place-items-center shrink-0 transition-colors",
                  active ? "bg-accent/10 text-accent" : "bg-slate-100 text-ink/55"
                )}>
                  <Icon className="w-[15px] h-[15px]" />
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
      <div className="p-3 border-t border-slate-100">
        <button
          onClick={() => router.push("/home")}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm border border-slate-200 bg-white text-ink/70 hover:bg-slate-50 hover:text-ink transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Exit dashboard
        </button>
        <div className="text-[11px] text-ink/45 text-center mt-2">
          signed in as <span className="text-ink/70">{user.name}</span>
        </div>
      </div>
    </aside>
  );
}
