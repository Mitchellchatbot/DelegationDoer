"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Sparkles, Search, ShieldAlert, Camera, FolderKanban } from "lucide-react";
import { useCurrentUser } from "@/lib/user-context";
import { isLeader } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Tab = {
  href: string;
  label: string;
  icon: typeof Sparkles;
  seoOnly?: boolean;
  leaderOnly?: boolean;
};
const TABS: readonly Tab[] = [
  { href: "/updates/eod",       label: "EOD",       icon: Sparkles                            },
  { href: "/updates/seo",       label: "SEO",       icon: Search,      seoOnly: true          },
  { href: "/updates/projects",  label: "Projects",  icon: FolderKanban, leaderOnly: true      },
  { href: "/updates/incidents", label: "Incidents", icon: ShieldAlert                         },
  { href: "/updates/moments",   label: "Moments",   icon: Camera                              }
] as const;

export function UpdatesTabs() {
  const pathname = usePathname();
  const me = useCurrentUser();
  // SEO tab is visible to anyone on the SEO team OR the leader, so
  // requests don't get silently hidden from the person who can route
  // them.
  const canSeeSeo = (me.departmentIds ?? []).includes("dep_seo") || isLeader(me);
  const canSeeProjects = isLeader(me);
  const tabs = TABS.filter((t) => {
    if (t.seoOnly && !canSeeSeo) return false;
    if (t.leaderOnly && !canSeeProjects) return false;
    return true;
  });

  // Live count of open SEO report requests. Polled lightly so a fresh
  // submission lights up the badge within a few seconds without
  // hammering the API.
  const [openSeoCount, setOpenSeoCount] = useState<number | null>(null);
  const [unseenProjects, setUnseenProjects] = useState<number | null>(null);
  useEffect(() => {
    if (!canSeeSeo && !canSeeProjects) return;
    let cancelled = false;
    async function fetchCounts() {
      try {
        if (canSeeSeo) {
          const res = await fetch("/api/seo-reports/summary", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) setOpenSeoCount(data.openCount ?? 0);
          }
        }
        if (canSeeProjects) {
          const res = await fetch("/api/projects/updates?limit=1", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) setUnseenProjects(data.unseenCount ?? 0);
          }
        }
      } catch { /* ignore */ }
    }
    fetchCounts();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fetchCounts();
    }, 30_000);
    const onVis = () => { if (document.visibilityState === "visible") fetchCounts(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [canSeeSeo, canSeeProjects]);

  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        let badge: number | null = null;
        let badgeTitle = "";
        if (href === "/updates/seo" && (openSeoCount ?? 0) > 0) {
          badge = openSeoCount;
          badgeTitle = `${openSeoCount} open SEO ${openSeoCount === 1 ? "request" : "requests"}`;
        } else if (href === "/updates/projects" && (unseenProjects ?? 0) > 0) {
          badge = unseenProjects;
          badgeTitle = `${unseenProjects} new project ${unseenProjects === 1 ? "update" : "updates"}`;
        }
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors",
              active ? "bg-accent text-white" : "text-muted hover:text-ink hover:bg-surface2"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {badge !== null && (
              <span
                className={cn(
                  "ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums",
                  active
                    ? "bg-white text-accent"
                    : "bg-rose-500 text-white"
                )}
                title={badgeTitle}
              >
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
