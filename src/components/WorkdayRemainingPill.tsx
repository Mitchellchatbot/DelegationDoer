"use client";

import { Clock } from "lucide-react";
import { useClock } from "./ClockContext";

// Compact pill for the sidebar / header showing how much of the workday is
// left. Falls back to "off shift" copy when nothing's been clocked yet.
export function WorkdayRemainingPill() {
  const { clock } = useClock();
  const cap = clock.dailyCapacityHours;
  const remH = clock.workdayRemainingMs / 3_600_000;
  const pctUsed = Math.min(1, Math.max(0, 1 - remH / Math.max(1, cap)));
  const tone =
    pctUsed > 0.85
      ? "text-rose-600 border-rose-200 bg-rose-50/70"
      : pctUsed > 0.7
      ? "text-amber-700 border-amber-200 bg-amber-50/70"
      : "text-emerald-700 border-emerald-200 bg-emerald-50/70";
  return (
    <div
      className={
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium " +
        tone
      }
      title={`${remH.toFixed(1)}h remaining of ${cap}h workday`}
    >
      <Clock className="w-3 h-3" />
      <span className="tabular-nums">{remH.toFixed(1)}h left today</span>
    </div>
  );
}
