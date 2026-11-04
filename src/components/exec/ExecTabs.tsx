import Link from "next/link";
import { cn } from "@/lib/utils";

// The exec page tabs (ScaleTabs' pattern): each page passes the tab it is,
// so this stays a server component with no hooks. Only tabs whose page exists
// are listed, so it never links to a 404: P2b shipped Overview, P3 adds Email,
// and later phases add Team, Projects and Chat to EXEC_TABS. The Email tab
// shows even while email intelligence is off; its page says so.

export interface ExecTab {
  key: string;
  /** A DD path. */
  href: string;
  label: string;
}

export const EXEC_TABS: readonly ExecTab[] = [
  { key: "overview", href: "/executive", label: "Overview" },
  { key: "email", href: "/executive/email", label: "Email" }
];

export function ExecTabs({ active, tabs }: { active: string; tabs: readonly ExecTab[] }) {
  return (
    <nav
      aria-label="Executive AI Assistant"
      className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-slate-200 bg-white p-0.5 shadow-soft"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "shrink-0 rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors",
            tab.key === active ? "bg-indigo-600 text-white" : "text-muted hover:text-ink"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
