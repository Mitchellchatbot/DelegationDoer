import Link from "next/link";
import { cn } from "@/lib/utils";

// The Scale Room's tabs. The active tab is passed in by each page rather than
// read from the path, so this stays a server component with no hooks.
const TABS = [
  { key: "overview", href: "/scale", label: "Overview" },
  { key: "outbound", href: "/scale/outbound", label: "Outbound" }
] as const;

export type ScaleTab = (typeof TABS)[number]["key"];

export function ScaleTabs({ active }: { active: ScaleTab }) {
  return (
    <nav aria-label="Scale Room" className="inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-white p-0.5 shadow-soft">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors",
            t.key === active ? "bg-indigo-600 text-white" : "text-muted hover:text-ink"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
