"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, LayoutGroup } from "framer-motion";
import { ListTodo, Columns3, ListChecks, Archive } from "lucide-react";
import { useCurrentUser } from "@/lib/user-context";
import { isLeader } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Tab = {
  href: string;
  label: string;
  icon: typeof ListTodo;
  leaderOnly?: boolean;
  // false = don't prefetch this tab's page while the strip is on screen;
  // it loads on click instead. Default true.
  prefetch?: boolean;
};

const TABS: readonly Tab[] = [
  { href: "/tasks/todos", label: "Todos", icon: ListChecks, leaderOnly: true },
  { href: "/tasks/mine",  label: "Mine",  icon: ListTodo },
  { href: "/tasks/board", label: "Board", icon: Columns3 },
  // Finished work swept off the live board. Everyone may open it (the page
  // applies the same leader-privacy filter as the live list), so no
  // leaderOnly flag. prefetch: false because a bare <Link prefetch> is a
  // FULL prefetch in Next 14 - a complete server render of the target page.
  // The archived page is force-dynamic and reads every archived task
  // (no limit), and this strip is on screen for every Tasks view, so
  // prefetching it would run that query for every user on every Mine /
  // Board / Todos load. Clicking the tab still feels instant: the route
  // has its own loading.tsx.
  { href: "/tasks/archived", label: "Archived", icon: Archive, prefetch: false }
] as const;

// Segmented control with a framer-motion blob that slides between
// segments on click. Clicking still navigates via Next.js Link, but
// the blob animates immediately so the UI feels instant even while
// the next route is fetching its data.
export function TasksTabs() {
  const pathname = usePathname();
  const me = useCurrentUser();
  const canSeeLeaderTabs = isLeader(me);
  const tabs = TABS.filter((t) => !t.leaderOnly || canSeeLeaderTabs);

  return (
    <LayoutGroup id="tasks-tabs">
      <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
        {tabs.map(({ href, label, icon: Icon, prefetch }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              prefetch={prefetch ?? true}
              className={cn(
                "relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors z-0",
                active ? "text-white" : "text-muted hover:text-ink"
              )}
            >
              {active && (
                <motion.span
                  layoutId="tasks-tab-blob"
                  transition={{ type: "spring", stiffness: 500, damping: 36 }}
                  className="absolute inset-0 -z-10 rounded-lg bg-accent shadow-sm"
                />
              )}
              <Icon className="w-3.5 h-3.5 relative" />
              <span className="relative">{label}</span>
            </Link>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
