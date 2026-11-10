import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { ageLabel, formatInZone, MISSING } from "@/lib/exec/format";
import { cn } from "@/lib/utils";

// Small pieces shared by the email surfaces. Server components, text only.

export type ChipTone = "slate" | "indigo" | "amber" | "rose" | "emerald" | "sky" | "violet";

export const CHIP_TONE: Readonly<Record<ChipTone, string>> = {
  slate: "border-slate-200 bg-slate-50 text-slate-700",
  indigo: "border-indigo-200/70 bg-indigo-50 text-indigo-700",
  amber: "border-amber-200/80 bg-amber-50 text-amber-800",
  rose: "border-rose-200/80 bg-rose-50 text-rose-700",
  emerald: "border-emerald-200/80 bg-emerald-50 text-emerald-700",
  sky: "border-sky-200/80 bg-sky-50 text-sky-700",
  violet: "border-violet-200/80 bg-violet-50 text-violet-700"
};

export function Chip({ tone = "slate", title, children }: { tone?: ChipTone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex max-w-full items-center rounded-full border px-2 py-px text-[11px] font-medium", CHIP_TONE[tone])}>
      <span className="truncate">{children}</span>
    </span>
  );
}

/** An amber "couldn't" line inside a card (a part of it failed; the rest stands). */
export function Unavailable({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** "5 min ago", "just now", or "—". */
export function ago(iso: string | null | undefined, now: string): string {
  const age = ageLabel(iso, now);
  return age === MISSING || age === "just now" ? age : `${age} ago`;
}

/** A <time> showing how long ago, with the exact time in his zone as its title. */
export function Ago({ iso, now, tz, className }: { iso: string | null | undefined; now: string; tz: string; className?: string }) {
  if (!iso) return <span className={className}>{MISSING}</span>;
  return (
    <time dateTime={iso} title={formatInZone(iso, tz, "datetime", now)} className={className}>
      {ago(iso, now)}
    </time>
  );
}

/** A <time> showing the exact time in his zone. */
export function When({ iso, now, tz, mode = "datetime", className }: { iso: string | null | undefined; now: string; tz: string; mode?: "date" | "datetime" | "time"; className?: string }) {
  if (!iso) return <span className={className}>{MISSING}</span>;
  return (
    <time dateTime={iso} className={className}>
      {formatInZone(iso, tz, mode, now)}
    </time>
  );
}
