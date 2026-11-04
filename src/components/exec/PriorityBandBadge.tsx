import type { PriorityBand } from "@/lib/exec/attention-types";
import { cn } from "@/lib/utils";

// The deterministic priority band of an attention item (priority.ts), with
// the score and every contribution in the tooltip, so a band can always be
// traced back to plain facts. Not Badges.tsx's PriorityBadge, which shows a
// task's own low/medium/high/critical.
export const BAND_META: Readonly<Record<PriorityBand, { label: string; className: string }>> = {
  critical: { label: "Critical", className: "badge-critical" },
  high: { label: "High", className: "badge-high" },
  normal: { label: "Normal", className: "badge-low" }
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
  const meta = BAND_META[band] ?? { label: String(band), className: "badge-low" };
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
