"use client";

import * as RT from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

// Thin wrapper around Radix Tooltip with our chrome:
//   - 150ms open delay (snappier than the native ~500ms title attr)
//   - black bubble, white text, rounded, small drop shadow
//   - portaled so it can escape overflow:hidden parents (like the
//     client-health card's overflow-y-auto list)
//
// Wrap any element with <Tooltip label="…">{element}</Tooltip> — the
// child still receives focus / pointer events normally because Radix
// uses an invisible trigger sibling.
//
// asChild=true would let the child be the trigger directly, but only
// works on a single element that accepts a ref. The default wraps the
// child in a <span>, which is safer for the dashboard's mix of icons +
// links + buttons + pills.

const PROVIDER_DELAY_MS = 150;

export function TooltipRoot({ children }: { children: ReactNode }) {
  // Single Provider at the root keeps delay state coherent across the
  // dashboard (when one tooltip closes and another opens within the
  // delayDuration window, the second appears immediately — "tooltip
  // mode" in Radix-speak).
  return (
    <RT.Provider delayDuration={PROVIDER_DELAY_MS} skipDelayDuration={150}>
      {children}
    </RT.Provider>
  );
}

interface TooltipProps {
  /** Tooltip text. Skips render when empty/null so callers can pass
   *  conditional copy without an outer ternary. */
  label?: ReactNode;
  /** Where the bubble appears relative to the trigger. */
  side?: "top" | "right" | "bottom" | "left";
  /** Bubble alignment along the trigger's edge. */
  align?: "start" | "center" | "end";
  /** Optional class added to the bubble (e.g. wider tooltip for long copy). */
  className?: string;
  children: ReactNode;
}

export function Tooltip({
  label,
  side = "top",
  align = "center",
  className,
  children
}: TooltipProps) {
  // Bail when there's nothing to say — saves a wrapping span and a
  // Radix mount.
  if (!label) return <>{children}</>;
  return (
    <RT.Root>
      <RT.Trigger asChild>
        <span className="inline-flex">{children}</span>
      </RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            "z-50 max-w-xs rounded-md px-2 py-1 text-[11px] font-medium leading-snug shadow-lg",
            "bg-slate-900 text-white",
            "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            className
          )}
        >
          {label}
          <RT.Arrow className="fill-slate-900" width={9} height={5} />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
