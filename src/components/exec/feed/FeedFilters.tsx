import Link from "next/link";
import type { AttentionCategory, AttentionFilters, AttentionSource, AttentionStatusFilter, PriorityBand } from "@/lib/exec/attention-types";
import { cn } from "@/lib/utils";

// The full feed's filters (P5a contract §3.13.2, A2, C6): plain links, so
// they work without JS and every view has its own URL. Each link keeps the
// other filters and changes one; the current value carries aria-current.
// "Active" is the default view (open and seen, expired snoozes included).

type FilterKey = "status" | "category" | "band" | "source";

interface Option<V extends string> {
  value: V | undefined;
  label: string;
}

const STATUS: readonly Option<AttentionStatusFilter>[] = [
  { value: undefined, label: "Active" },
  { value: "open", label: "Open" },
  { value: "seen", label: "Seen" },
  { value: "snoozed", label: "Snoozed" },
  { value: "dismissed", label: "Dismissed" },
  { value: "resolved", label: "Resolved" }
];
const CATEGORY: readonly Option<AttentionCategory>[] = [
  { value: undefined, label: "All" },
  { value: "my_action", label: "Your action" },
  { value: "approval", label: "Approval" },
  { value: "delegated", label: "Delegated" },
  { value: "intervene", label: "Intervene" },
  { value: "fyi", label: "FYI" },
  { value: "on_track", label: "On track" }
];
const BAND: readonly Option<PriorityBand>[] = [
  { value: undefined, label: "All" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" }
];
const SOURCE: readonly Option<AttentionSource>[] = [
  { value: undefined, label: "All" },
  { value: "dd", label: "DD" },
  { value: "email", label: "Email" },
  { value: "slack", label: "Slack" }
];

const GROUPS: readonly { key: FilterKey; label: string; options: readonly Option<string>[] }[] = [
  { key: "status", label: "Status", options: STATUS },
  { key: "category", label: "Category", options: CATEGORY },
  { key: "band", label: "Priority", options: BAND },
  { key: "source", label: "Source", options: SOURCE }
];

/** The feed page's URL for `filters` with one filter set (undefined clears it). "default" status is the bare URL. */
export function feedFilterHref(filters: AttentionFilters, key: FilterKey, value: string | undefined): string {
  const next: Partial<Record<FilterKey, string | undefined>> = {
    status: filters.status && filters.status !== "default" ? filters.status : undefined,
    category: filters.category,
    band: filters.band,
    source: filters.source
  };
  next[key] = value === "default" ? undefined : value;
  const q = new URLSearchParams();
  for (const k of ["status", "category", "band", "source"] as const) {
    const v = next[k];
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return qs ? `/executive/attention?${qs}` : "/executive/attention";
}

function currentValue(filters: AttentionFilters, key: FilterKey): string | undefined {
  const v = filters[key];
  return key === "status" && v === "default" ? undefined : v;
}

export function FeedFilters({ filters }: { filters: AttentionFilters }) {
  return (
    <div data-feed-filters className="space-y-2">
      {GROUPS.map((group) => {
        const current = currentValue(filters, group.key);
        return (
          <nav key={group.key} aria-label={`Filter by ${group.label.toLowerCase()}`} className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.label}</span>
            {group.options.map((opt) => {
              const active = opt.value === current;
              return (
                <Link
                  key={opt.label}
                  href={feedFilterHref(filters, group.key, opt.value)}
                  prefetch={false}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[12px] font-semibold transition-colors",
                    active ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:text-ink"
                  )}
                >
                  {opt.label}
                </Link>
              );
            })}
          </nav>
        );
      })}
    </div>
  );
}
