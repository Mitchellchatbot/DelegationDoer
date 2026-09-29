"use client";

import { useEffect, useState, type ReactNode } from "react";

// In-page tabs for /finance. All five panels are rendered once on the server
// (one data load) and passed in as slots; this only toggles which is visible.
// The active tab is remembered per browser so a refresh keeps your place.

type TabKey = "overview" | "facebook" | "seo" | "expenses" | "projections";
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "facebook", label: "Facebook" },
  { key: "seo", label: "SEO" },
  { key: "expenses", label: "Expenses & P&L" },
  { key: "projections", label: "Projections" }
];
const STORE_KEY = "finance.activeTab";

export function FinanceTabsView(slots: Record<TabKey, ReactNode>) {
  const [active, setActive] = useState<TabKey>("overview");

  // Restore the last tab after mount (avoids a hydration mismatch).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE_KEY) as TabKey | null;
      if (saved && TABS.some((t) => t.key === saved)) setActive(saved);
    } catch { /* private mode / blocked storage */ }
  }, []);

  function pick(key: TabKey) {
    setActive(key);
    try { localStorage.setItem(STORE_KEY, key); } catch { /* ignore */ }
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 flex-wrap border-b border-slate-200 pb-2 mb-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => pick(t.key)}
            className={
              "text-[13px] font-medium rounded-lg px-3 py-1.5 transition-colors " +
              (active === t.key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {slots[active]}
    </div>
  );
}
