"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHoverEdgeScroll } from "@/lib/use-hover-edge-scroll";

// Reusable horizontally-scrollable wrapper with hover edge auto-scroll: hover
// near the left/right edge and the content scrolls that way (see
// use-hover-edge-scroll). Shows a soft fade + chevron on an edge only while
// more content is hidden that direction. Drop it in place of a plain
// `overflow-x-auto` div around a wide table.
export function HoverScrollArea({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { containerRef, onMouseMove, onMouseLeave, edges } = useHoverEdgeScroll();

  return (
    <div className="relative">
      <div
        ref={containerRef}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        className={cn("overflow-x-auto", className)}
      >
        {children}
      </div>

      {/* Edge cues sit above the scroll area but never intercept the pointer,
          so hovering "through" them still drives the scroll and the underlying
          Actions buttons stay clickable. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center justify-start pl-1 bg-gradient-to-r from-surface to-transparent transition-opacity duration-200",
          edges.left ? "opacity-100" : "opacity-0"
        )}
      >
        <ChevronLeft className="w-4 h-4 text-muted" />
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end pr-1 bg-gradient-to-l from-surface to-transparent transition-opacity duration-200",
          edges.right ? "opacity-100" : "opacity-0"
        )}
      >
        <ChevronRight className="w-4 h-4 text-muted" />
      </div>
    </div>
  );
}
