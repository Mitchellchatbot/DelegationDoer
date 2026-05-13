"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListTodo, Columns3, Layers } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/tasks/mine",  label: "Mine",  icon: ListTodo },
  { href: "/tasks/board", label: "Board", icon: Columns3 },
  { href: "/tasks/all",   label: "All",   icon: Layers }
] as const;

export function TasksTabs() {
  const pathname = usePathname();
  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
      {TABS.map(({ href, label, icon: Icon }) => {
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
