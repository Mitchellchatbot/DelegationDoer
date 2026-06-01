"use client";

import { TOUCHPOINT_META, type TouchpointLabel, daysSince } from "@/lib/client-touchpoint";
import { cn } from "@/lib/utils";

// Color-coded touchpoint pill. Shows traffic-light status + an
// optional "Nd" age chip (days since last outbound email). Used on:
//   - client list rows
//   - client detail header
//   - dashboard follow-up widget
//   - inbox client tab
//
// Renders nothing if `label` is missing — call sites always have a
// label since computeTouchpointLabel() returns 'red' for null sends.
export function TouchpointPill({
  label,
  lastSentAt,
  isOverride,
  showAge = true,
  size = "sm",
  className
}: {
  label: TouchpointLabel | null;
  lastSentAt?: string | null;
  isOverride?: boolean;
  showAge?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!label) return null;
  const meta = TOUCHPOINT_META[label];
  const small = size === "sm";
  const days = daysSince(lastSentAt ?? null);

  // Always lead with the day count. "Never sent an email" / "Sent today"
  // / "Xd since last email" reads at a glance — the old status word
  // ("Neglected" / "Stale") was confusing because people thought it
  // referred to the relationship overall rather than the email cadence.
  // Falls back to the status word only when the caller didn't pass
  // lastSentAt at all (i.e. the surface deliberately doesn't have it).
  const showDays = showAge && lastSentAt !== undefined;
  const dayLabel = (() => {
    if (!showDays) return null;
    if (days === null) return "Never sent an email";
    if (days === 0) return "Sent today";
    if (days === 1) return "1d since last email";
    return `${days}d since last email`;
  })();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium",
        small ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-[12px]",
        meta.bg, meta.text, meta.border,
        isOverride && "ring-2 ring-offset-1 ring-ink/15",
        className
      )}
      title={
        meta.description +
        (showDays ? ` · ${dayLabel}.` : "") +
        (isOverride ? " · Manually set by a leader." : "")
      }
    >
      <span className={cn("rounded-full shrink-0", small ? "w-1.5 h-1.5" : "w-2 h-2", meta.dot)} />
      <span>{dayLabel ?? meta.label}</span>
    </span>
  );
}
