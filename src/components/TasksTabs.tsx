"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListTodo, Columns3, Layers, ListChecks } from "lucide-react";
import { useCurrentUser } from "@/lib/user-context";
import { isLeader } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Tab = {
  href: string;
  label: string;
  icon: typeof ListTodo;
  leaderOnly?: boolean;
};

const TABS: readonly Tab[] = [
  { href: "/tasks/mine",  label: "Mine",  icon: ListTodo },
  { href: "/tasks/board", label: "Board", icon: Columns3 },
  { href: "/tasks/all",   label: "All",   icon: Layers   },
  { href: "/tasks/todos", label: "Todos", icon: ListChecks, leaderOnly: true }
] as const;

export function TasksTabs() {
  const pathname = usePathname();
  const me = useCurrentUser();
  const canSeeLeaderTabs = isLeader(me);
  const tabs = TABS.filter((t) => !t.leaderOnly || canSeeLeaderTabs);

  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors",
              active ? "bg-accent text-white" : "text-muted hover:text-ink hover:bg-surface2"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
