"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, Search, ShieldAlert, Camera } from "lucide-react";
import { useCurrentUser } from "@/lib/user-context";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/updates/eod",       label: "EOD",       icon: Sparkles,    seoOnly: false },
  { href: "/updates/seo",       label: "SEO",       icon: Search,      seoOnly: true  },
  { href: "/updates/incidents", label: "Incidents", icon: ShieldAlert, seoOnly: false },
  { href: "/updates/moments",   label: "Moments",   icon: Camera,      seoOnly: false }
] as const;

export function UpdatesTabs() {
  const pathname = usePathname();
  const me = useCurrentUser();
  const canSeeSeo = (me.departmentIds ?? []).includes("dep_seo");
  const tabs = TABS.filter((t) => !t.seoOnly || canSeeSeo);

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
