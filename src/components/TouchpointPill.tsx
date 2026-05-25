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
  showAge = false,
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

  // Always lead with the day count when we know one. Falls back to the
  // status word ("Healthy" / "Stale" / "Neglected") when the caller
  // didn't pass lastSentAt or when no email is on record. Per spec
  // change — feedback was that "Neglected" alone was confusing; a
  // literal "12d since last email" reads at a glance.
  const showDays = showAge && lastSentAt !== undefined;
  const dayLabel = (() => {
    if (!showDays) return null;
    if (days === null) return "Never emailed";
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
      {dayLabel ? (
        <>
          <span>{dayLabel}</span>
          {/* status word is the secondary token now */}
          {days !== null && (
            <span className={cn("opacity-70", small ? "text-[9px]" : "text-[10px]")}>
              · {meta.label}
            </span>
          )}
        </>
      ) : (
        meta.label
      )}
    </span>
  );
}
