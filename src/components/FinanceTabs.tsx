import Link from "next/link";
import { cn } from "@/lib/utils";

// Finance tabs. Active tab passed in by each page (server component, no hooks).
const TABS = [
  { key: "overview", href: "/finance", label: "Overview" },
  { key: "projections", href: "/finance/projections", label: "Projections" }
] as const;

export type FinanceTab = (typeof TABS)[number]["key"];

export function FinanceTabs({ active }: { active: FinanceTab }) {
  return (
    <nav aria-label="Finance" className="inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-white p-0.5 shadow-sm">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors",
            t.key === active ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
