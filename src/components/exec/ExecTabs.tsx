import Link from "next/link";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

// The exec page tabs (ScaleTabs' pattern): each page passes the tab it is,
// so this stays a server component with no hooks. Only tabs whose page exists
// are listed, so it never links to a 404: P2b shipped Overview, P3 added
// Email, P5a added Team and Projects (contract C23), and P5b added Chat. The
// Email tab shows even while email intelligence is off; its page says so.
// After the pill group, a gear links to Settings on every page; it is the
// current page when `active` is "settings". The full Needs Attention feed
// (/executive/attention) is reached from the Overview card, not a tab (C8).
// Below sm the pills are tighter (no gap, px-2, 12 px text), so all five fit
// beside the gear at a 390 px phone (review ui-6) instead of clipping the last.

export interface ExecTab {
  key: string;
  /** A DD path. */
  href: string;
  label: string;
}

export const EXEC_TABS: readonly ExecTab[] = [
  { key: "overview", href: "/executive", label: "Overview" },
  { key: "email", href: "/executive/email", label: "Email" },
  { key: "team", href: "/executive/team", label: "Team" },
  { key: "projects", href: "/executive/projects", label: "Projects" },
  { key: "chat", href: "/executive/chat", label: "Chat" }
];

export const SETTINGS_HREF = "/executive/settings";

export function ExecTabs({ active, tabs }: { active: string; tabs: readonly ExecTab[] }) {
  const settingsActive = active === "settings";
  return (
    <nav aria-label="Executive AI Assistant" className="flex max-w-full items-center gap-1.5">
      <div data-exec-tab-strip className="inline-flex min-w-0 max-w-full items-center gap-0 overflow-x-auto rounded-full border border-slate-200 bg-white p-0.5 shadow-soft sm:gap-0.5">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={tab.key === active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full px-2 py-1.5 text-[12px] font-semibold transition-colors sm:px-3.5 sm:text-[12.5px]",
              tab.key === active ? "bg-indigo-600 text-white" : "text-muted hover:text-ink"
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <Link
        href={SETTINGS_HREF}
        aria-label="Settings"
        title="Settings"
        aria-current={settingsActive ? "page" : undefined}
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-full border shadow-soft transition-colors",
          settingsActive ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-muted hover:text-ink"
        )}
      >
        <Settings className="h-4 w-4" aria-hidden />
      </Link>
    </nav>
  );
}
