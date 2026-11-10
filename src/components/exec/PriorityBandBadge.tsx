import type { PriorityBand } from "@/lib/exec/attention-types";
import { cn } from "@/lib/utils";

// The deterministic priority band of an attention item (priority.ts), with
// the score and every contribution in the tooltip, so a band can always be
// traced back to plain facts. Not Badges.tsx's PriorityBadge, which shows a
// task's own low/medium/high/critical.
// P9 F5 (WCAG AA): exec-specific tones, at least 4.5:1 (the global badge-* classes stay as they are for the rest of DD:
// badge-high was 2.86:1, badge-critical 4.13:1, badge-low 4.34:1). ui/kit.test.ts computes every pair.
export const BAND_META: Readonly<Record<PriorityBand, { label: string; className: string }>> = {
  critical: { label: "Critical", className: "border-rose-200 bg-rose-50 text-rose-700" },
  high: { label: "High", className: "border-amber-200 bg-amber-50 text-amber-800" },
  normal: { label: "Normal", className: "border-slate-200 bg-slate-100 text-slate-600" }
};

export function PriorityBandBadge({
  band,
  score,
  reasons
}: {
  band: PriorityBand;
  score?: number;
  reasons?: readonly string[];
}) {
  const meta = BAND_META[band] ?? { label: String(band), className: BAND_META.normal.className };
  const lines = [
    ...(typeof score === "number" && Number.isFinite(score) ? [`Priority score ${score} of 100`] : []),
    ...(reasons ?? [])
  ];
  return (
    <span className={cn("badge", meta.className)} title={lines.length > 0 ? lines.join("\n") : undefined}>
      <span className="sr-only">Priority: </span>
      {meta.label}
    </span>
  );
}
