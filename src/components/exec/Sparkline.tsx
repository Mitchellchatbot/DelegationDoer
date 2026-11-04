// A real series as a small area line, drawn on the server (copied from
// OutboundMetaDashboard's file-private Sparkline). Never decorative: the
// numbers come from the caller, and a series it can't draw truthfully renders
// nothing, so the figure next to it stands alone.

/** Stroke colors per tile tint (OutboundMetaDashboard's SPARK, plus slate). */
export const SPARK_COLOR = {
  indigo: "#6366f1",
  emerald: "#3fae74",
  teal: "#0ea5a4",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  rose: "#ec4899",
  sky: "#38bdf8",
  slate: "#64748b"
} as const;

export function Sparkline({
  data,
  color = SPARK_COLOR.indigo,
  label
}: {
  data: readonly number[];
  color?: string;
  /** Describes the series for screen readers ("Completed per day, last 7 days: …"). Without it the chart is hidden from them. */
  label?: string;
}) {
  // One point is not a line, and a negative or non-finite count would be drawn
  // as something it isn't.
  if (data.length < 2 || data.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const w = 120;
  const h = 24;
  const max = data.reduce((m, v) => Math.max(m, v), 0);
  const step = w / (data.length - 1);
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (max > 0 ? (v / max) * (h - 2) : 0) - 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="mt-2 h-6 w-full"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
