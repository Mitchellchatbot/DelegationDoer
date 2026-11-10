import Link from "next/link";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

// The exec page tabs (ScaleTabs' pattern): each page passes the tab it is,
// so this stays a server component with no hooks. Only tabs whose page exists
// are listed, so it never links to a 404: P2b shipped Overview, P3 added
// Email, P5a added Team and Projects (contract C23), P5b added Chat, P7b
// added Slack after Email (P7b contract §3.17.1), and P8 added Brief right
// after Overview (P8 contract §3.17.3, AM-P8-23). The Email, Slack and Brief
// tabs show even while their feature is off; their pages say so.
// After the pill group, a gear links to Settings on every page; it is the
// current page when `active` is "settings". The full Needs Attention feed
// (/executive/attention) is reached from the Overview card, not a tab (C8).
// P9 (F25, WCAG 2.5.8): below sm every pill is a 40 px tap target (min-h-10,
// px-3, 12 px text) with a gap instead of shrinking to 30x29 px (P8 had
// squeezed all seven in at 390 px); the gear is 40x40. P9 fixer ui-2: below
// sm the strip wraps onto a second row (EXEC_TAB_STRIP) rather than scrolling,
// so the current tab is always on screen with no script (a scrolled strip
// loads scrolled to its start, hiding Projects and Chat). From sm up the strip
// looks as before: one row, scrolling only if a narrow window needs it.

export interface ExecTab {
  key: string;
  /** A DD path. */
  href: string;
  label: string;
}

export const EXEC_TABS: readonly ExecTab[] = [
  { key: "overview", href: "/executive", label: "Overview" },
  { key: "brief", href: "/executive/brief", label: "Brief" },
  { key: "email", href: "/executive/email", label: "Email" },
  { key: "slack", href: "/executive/slack", label: "Slack" },
  { key: "team", href: "/executive/team", label: "Team" },
  { key: "projects", href: "/executive/projects", label: "Projects" },
  { key: "chat", href: "/executive/chat", label: "Chat" }
];

export const SETTINGS_HREF = "/executive/settings";

/** P9 (F25): a tab pill: 40 px tall below sm, as before from sm up. */
export const EXEC_TAB_PILL =
  "inline-flex min-h-10 shrink-0 items-center rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors sm:min-h-0 sm:px-3.5 sm:text-[12.5px]";
/** P9 (F25): the Settings gear: 40x40 below sm, 32x32 from sm up. */
export const EXEC_GEAR = "grid h-10 w-10 shrink-0 place-items-center rounded-full border shadow-soft transition-colors sm:h-8 sm:w-8";
/** P9 fixer ui-2: the pill group: wraps (rounded-2xl) below sm, one rounded-full row from sm up. */
export const EXEC_TAB_STRIP =
  "inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-0.5 shadow-soft sm:flex-nowrap sm:gap-0.5 sm:rounded-full";

export function ExecTabs({ active, tabs }: { active: string; tabs: readonly ExecTab[] }) {
  const settingsActive = active === "settings";
  return (
    <nav aria-label="Executive AI Assistant" className="flex max-w-full items-center gap-1.5">
      <div data-exec-tab-strip className={EXEC_TAB_STRIP}>
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={tab.key === active ? "page" : undefined}
            className={cn(
              EXEC_TAB_PILL,
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
          EXEC_GEAR,
          settingsActive ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-muted hover:text-ink"
        )}
      >
        <Settings className="h-4 w-4" aria-hidden />
      </Link>
    </nav>
  );
}
