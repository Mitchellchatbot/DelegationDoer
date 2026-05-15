"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Crown } from "lucide-react";

// Topbar Employee-of-the-Month pill. Visible to everyone signed in —
// quick "who's crowned right now" glance that links to the
// Recommendations page (where the EOM curates picks). Refreshes every
// 5 minutes (cheap) so a new crown surfaces without a reload.

interface Eom {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  month: string;
}

export function EomPill() {
  const [eom, setEom] = useState<Eom | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/eom", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setEom(data.eom ?? null);
      } catch { /* surfaces on next tick */ }
    }
    void load();
    const t = setInterval(() => {
      // Throttle when the tab is hidden.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load();
    }, 300_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!eom?.name) return null;
  const firstName = eom.name.split(" ")[0];
  return (
    <Link
      href="/updates/recommendations"
      title={`Employee of the Month · ${eom.name}`}
      className="hidden md:inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full border border-amber-200/80 bg-gradient-to-r from-amber-50 to-amber-100/60 text-amber-900 hover:from-amber-100 hover:to-amber-200/70 transition-colors shadow-sm"
    >
      <Crown className="w-3.5 h-3.5 text-amber-500" />
      <span className="text-[11px] font-semibold leading-none">
        EOM
      </span>
      <span className="text-[11px] text-amber-900/85 leading-none">
        {firstName}
      </span>
    </Link>
  );
}
