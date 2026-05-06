"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, ListTodo, Columns3, FolderKanban, Users, ShieldAlert,
  Sparkles, Settings, AlertTriangle, Crown
} from "lucide-react";
import { useState } from "react";
import { ReportIncidentDialog } from "./ReportIncidentDialog";
import { AIAssistantDrawer } from "./AIAssistantDrawer";
import { RaiseLink } from "./RaiseLink";
import { currentUser } from "@/lib/mock-data";
import { isCEO } from "@/lib/auth";

const BASE_NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/my-tasks", label: "My Tasks", icon: ListTodo },
  { href: "/board", label: "Board", icon: Columns3 },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/team", label: "Team", icon: Users },
  { href: "/incidents", label: "Incidents", icon: ShieldAlert }
];
const CEO_NAV = [{ href: "/ceo", label: "CEO Console", icon: Crown }];

export function Sidebar() {
  const path = usePathname();
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  // CEOs land on /ceo (Dashboard redirects there for them) so we drop the
  // Dashboard entry and lead with CEO Console.
  const NAV = isCEO(currentUser)
    ? [...CEO_NAV, ...BASE_NAV.filter((i) => i.href !== "/")]
    : BASE_NAV;

  return (
    <aside className="w-60 shrink-0 h-screen sticky top-0 border-r border-border bg-surface/60 backdrop-blur flex flex-col">
      <div className="px-4 h-14 flex items-center gap-2.5 border-b border-border">
        <div className="w-8 h-8 rounded-full overflow-hidden border border-border bg-surface2 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-medium">DelegationDoer</div>
          <div className="text-[11px] text-muted">scaledai.org</div>
        </div>
      </div>

      <nav className="px-2 py-3 space-y-0.5">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = path === item.href || (item.href !== "/" && path.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm transition-all duration-150 active:scale-[0.98]",
                active ? "bg-surface text-ink border border-border shadow-soft" : "text-muted hover:text-ink hover:bg-surface/60 border border-transparent"
              )}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 mt-2">
        <button onClick={() => setIncidentOpen(true)} className="btn-danger w-full justify-center">
          <AlertTriangle className="w-4 h-4" />
          Report incident
        </button>
      </div>

      <div className="px-3 mt-2">
        <button onClick={() => setAiOpen(true)} className="btn w-full justify-center">
          <Sparkles className="w-4 h-4" />
          Ask AI <span className="kbd ml-auto">⌘K</span>
        </button>
      </div>

      <div className="mt-auto p-3 border-t border-border space-y-2">
        <Link href="/settings" className="flex items-center gap-2 text-xs text-muted hover:text-ink">
          <Settings className="w-3.5 h-3.5" /> Settings
        </Link>
        <RaiseLink />
      </div>

      <ReportIncidentDialog open={incidentOpen} onOpenChange={setIncidentOpen} />
      <AIAssistantDrawer open={aiOpen} onOpenChange={setAiOpen} />
    </aside>
  );
}
