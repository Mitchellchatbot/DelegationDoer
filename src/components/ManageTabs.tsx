"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Crown, Users, BarChart3 } from "lucide-react";
import { useCurrentUser } from "@/lib/user-context";
import { cn } from "@/lib/utils";

type Tab = { href: string; label: string; icon: typeof Crown };

export function ManageTabs() {
  const pathname = usePathname();
  const me = useCurrentUser();

  const tabs: Tab[] =
    me.role === "leader"
      ? [
          { href: "/leader/console",   label: "Console",   icon: Crown },
          { href: "/leader/analytics", label: "Analytics", icon: BarChart3 }
        ]
      : me.role === "department_head"
        ? [
            { href: "/leader/team",      label: "Team",      icon: Users },
            { href: "/leader/analytics", label: "Analytics", icon: BarChart3 }
          ]
        : [];

  if (tabs.length === 0) return null;

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
