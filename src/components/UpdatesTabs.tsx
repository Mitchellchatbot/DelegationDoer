"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Sparkles, Search, ShieldAlert, Camera } from "lucide-react";
import { useCurrentUser } from "@/lib/user-context";
import { isLeader } from "@/lib/auth";
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
  // SEO tab is visible to anyone on the SEO team OR the leader, so
  // requests don't get silently hidden from the person who can route
  // them.
  const canSeeSeo = (me.departmentIds ?? []).includes("dep_seo") || isLeader(me);
  const tabs = TABS.filter((t) => !t.seoOnly || canSeeSeo);

  // Live count of open SEO report requests. Polled lightly so a fresh
  // submission lights up the badge within a few seconds without
  // hammering the API.
  const [openSeoCount, setOpenSeoCount] = useState<number | null>(null);
  useEffect(() => {
    if (!canSeeSeo) return;
    let cancelled = false;
    async function fetchCount() {
      try {
        const res = await fetch("/api/seo-reports/summary", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setOpenSeoCount(data.openCount ?? 0);
      } catch { /* ignore */ }
    }
    fetchCount();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fetchCount();
    }, 30_000);
    const onVis = () => { if (document.visibilityState === "visible") fetchCount(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [canSeeSeo]);

  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        const showBadge = href === "/updates/seo" && (openSeoCount ?? 0) > 0;
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
            {showBadge && (
              <span
                className={cn(
                  "ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums",
                  active
                    ? "bg-white text-accent"
                    : "bg-rose-500 text-white"
                )}
                title={`${openSeoCount} open SEO ${openSeoCount === 1 ? "request" : "requests"}`}
              >
                {openSeoCount}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
