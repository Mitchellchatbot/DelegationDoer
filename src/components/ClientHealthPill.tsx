"use client";

import { HEALTH_META, type HealthLabel } from "@/lib/client-health";
import { cn } from "@/lib/utils";

// Small color-coded pill rendered next to a client name to show
// account health at a glance. `overridden` adds a subtle ring so
// leaders know the value was hand-set vs. computed from emails.
export function ClientHealthPill({
  label, overridden, size = "sm", className
}: {
  label: HealthLabel | null;
  overridden?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!label) return null;
  const meta = HEALTH_META[label];
  const small = size === "sm";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium",
        small ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-[12px]",
        meta.bg, meta.text, meta.border,
        overridden && "ring-2 ring-offset-1 ring-ink/15",
        className
      )}
      title={
        meta.description + (overridden ? " · Override set by a leader." : "")
      }
    >
      <span className={cn("rounded-full", small ? "w-1.5 h-1.5" : "w-2 h-2", meta.dot)} />
      {meta.label}
    </span>
  );
}
