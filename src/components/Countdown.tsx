"use client";

import { useEffect, useState } from "react";

interface Props {
  // ISO 8601 timestamp from the DB (timestamptz). We compare against Date.now()
  // which is timezone-agnostic — both are absolute UTC milliseconds.
  iso: string | null;
  // Optional class merged into the span. Tone overrides apply on top.
  className?: string;
  // If true, also show the absolute due time in muted text inline (in the
  // viewer's local timezone). Default: only shown in the tooltip on hover.
  inlineDate?: boolean;
}

export function Countdown({ iso, className = "", inlineDate = false }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!iso) return;
    // Tick every second so the "Xm Ys" granularity feels live in the final
    // approach. Cheap; one interval per mounted card.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [iso]);

  if (!iso) {
    return <span className={`text-muted ${className}`}>no deadline</span>;
  }

  const target = new Date(iso).getTime();
  const ms = target - now;
  const overdue = ms < 0;
  const within1h = !overdue && ms < 3600_000;
  const within15m = !overdue && ms < 15 * 60_000;

  const label = formatCountdown(ms);

  // Tone (red overdue, amber within 1h, default otherwise). Caller can pass
  // a custom className to override sizing/spacing.
  const tone = overdue ? "text-urgent" : within15m ? "text-urgent" : within1h ? "text-warn" : "";
  const weight = overdue || within1h ? "font-medium" : "";

  // Absolute time in the viewer's local timezone, e.g. "Wed, May 6, 3:00 PM PDT".
  const absolute = new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });

  return (
    <span className={`${tone} ${weight} ${className}`} title={absolute}>
      {label}
      {inlineDate && (
        <span className="text-muted font-normal"> · {new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      )}
    </span>
  );
}

function formatCountdown(ms: number): string {
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  const secs = Math.floor((abs % 60_000) / 1000);

  let core: string;
  if (days >= 1) core = `${days}d ${hours}h`;
  else if (hours >= 1) core = `${hours}h ${mins}m`;
  else if (mins >= 5) core = `${mins}m`;
  else if (mins >= 1) core = `${mins}m ${secs}s`;
  else core = `${secs}s`;

  return overdue ? `overdue ${core}` : `${core} left`;
}
