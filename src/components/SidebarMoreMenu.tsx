"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  MoreHorizontal, CalendarDays, FolderKanban, Briefcase, BookOpen,
  Sparkles, Users, ClipboardCheck, Send, Settings, type LucideIcon
} from "lucide-react";
import { cn } from "@/lib/utils";

// Overflow popover for sidebar items that aren't in the primary row.
// Grouped by section (My work / Team / Knowledge / System) so the
// menu doesn't feel like a flat dumping ground.

interface MoreItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;        // when non-zero, gets a small pill in the row
}

interface MoreGroup {
  label: string;
  items: MoreItem[];
}

interface Props {
  groups: MoreGroup[];
}

export function SidebarMoreMenu({ groups }: Props) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Close the menu after navigating — the popover would otherwise sit
  // open over the new page until the user clicks away.
  useEffect(() => { setOpen(false); }, [path]);

  // Total nested badges → drives the dot on the trigger so users can
  // tell "something in More is calling for attention" without giving
  // them a count to parse.
  const totalNestedBadges = groups.reduce(
    (sum, g) => sum + g.items.reduce((s, i) => s + (i.badge ?? 0), 0),
    0
  );

  // "Is this More menu's row currently the active path?" Used to keep
  // the chevron tinted when, e.g., the user is on /schedule (which
  // lives inside More) so they don't feel lost.
  const activeInMenu = groups.some((g) =>
    g.items.some((i) => path === i.href || path.startsWith(i.href + "/"))
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[15px] transition-all duration-150 active:scale-[0.96] relative",
          activeInMenu
            ? "text-ink/80 bg-slate-100/70 font-medium"
            : "text-ink/70 hover:text-ink hover:bg-slate-100/70"
        )}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <MoreHorizontal className="w-[18px] h-[18px] shrink-0 text-slate-500" />
        <span>More</span>
        {totalNestedBadges > 0 && (
          <span
            className="ml-auto w-2 h-2 rounded-full bg-rose-500 ring-2 ring-white"
            aria-label={`${totalNestedBadges} items waiting inside More`}
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 mt-1 z-40 rounded-xl border border-slate-200 bg-white shadow-lift overflow-hidden"
        >
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {groups.map((g, gIdx) => (
              <div key={g.label}>
                {gIdx > 0 && <div className="my-1 mx-3 h-px bg-slate-100" />}
                <div className="px-3 pt-1.5 pb-1 text-[9px] uppercase tracking-[0.12em] font-semibold text-ink/45">
                  {g.label}
                </div>
                {g.items.map((item) => {
                  const Icon = item.icon;
                  const active = path === item.href || path.startsWith(item.href + "/");
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors",
                        active
                          ? "bg-accent/10 text-accent font-medium"
                          : "text-ink/75 hover:bg-slate-50 hover:text-ink"
                      )}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge && item.badge > 0 ? (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full text-[9px] font-bold tabular-nums text-white bg-rose-500">
                          {item.badge}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Re-exported icon set so the Sidebar can hand back the right icons
// for each group's items without re-importing all of lucide-react.
export const MoreIcons = {
  Schedule:        CalendarDays,
  Projects:        FolderKanban,
  Clients:         Briefcase,
  SOPs:            BookOpen,
  Updates:         Sparkles,
  People:          Users,
  Approvals:       ClipboardCheck,
  OutboundEmails:  Send,
  Settings:        Settings
} as const;
