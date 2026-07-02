"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Hover-driven horizontal auto-scroll for a wide, overflowing container
// (e.g. the Leader Console People table). While the mouse hovers inside the
// container, we nudge its `scrollLeft` once per animation frame when the
// pointer nears the left/right edge — so a user can reveal off-screen columns
// (like the trailing Actions column) without hunting for the bottom scroll bar.
//
// The edge math (proximity easing, EDGE_PX/MAX_SPEED_PX, scrollLeft clamping)
// is lifted verbatim from useHorizontalDragAutoScroll.ts so the feel is
// identical — that hook does the same for drag-and-drop boards; this is its
// hover twin, minus the @hello-pangea/dnd coupling.
//
// Mouse-only by nature (no touch listeners) so it never fights touch scroll,
// and it's a no-op unless the content actually overflows (the clamp makes
// idle frames free). `edges` reports whether more content exists each way so a
// caller can render a fade/chevron cue.

const EDGE_PX = 60; // start scrolling within this many px of an edge
const MAX_SPEED_PX = 18; // max px per frame at the very edge

export function useHoverEdgeScroll() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pointerXRef = useRef(0);
  const hoveringRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  // Whether more content is hidden to the left / right of the current scroll
  // position — drives the edge cues. Deduped so we re-render only on a change.
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < max - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  const tick = useCallback(() => {
    const el = containerRef.current;
    if (!el || !hoveringRef.current) {
      rafRef.current = null;
      return;
    }

    const rect = el.getBoundingClientRect();
    const x = pointerXRef.current;
    const fromLeft = x - rect.left;
    const fromRight = rect.right - x;
    let delta = 0;

    if (fromLeft < EDGE_PX && fromLeft > -EDGE_PX) {
      const p = Math.min(1, Math.max(0, (EDGE_PX - fromLeft) / EDGE_PX));
      delta = -Math.ceil(p * MAX_SPEED_PX);
    } else if (fromRight < EDGE_PX && fromRight > -EDGE_PX) {
      const p = Math.min(1, Math.max(0, (EDGE_PX - fromRight) / EDGE_PX));
      delta = Math.ceil(p * MAX_SPEED_PX);
    }

    if (delta !== 0) {
      const max = el.scrollWidth - el.clientWidth;
      const next = Math.min(max, Math.max(0, el.scrollLeft + delta));
      // Skip the write when already clamped so we don't thrash layout at the
      // extremes (and so resting on the far-right Actions buttons is stable).
      if (next !== el.scrollLeft) {
        el.scrollLeft = next;
        updateEdges();
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [updateEdges]);

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      pointerXRef.current = e.clientX;
      if (!hoveringRef.current) {
        hoveringRef.current = true;
        if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
      }
    },
    [tick]
  );

  const onMouseLeave = useCallback(() => {
    hoveringRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Keep the cue state fresh for manual scrolls (the bottom scroll bar) and
  // layout changes, and tear down the RAF loop on unmount.
  useEffect(() => {
    updateEdges();
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateEdges, { passive: true });
    window.addEventListener("resize", updateEdges);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      window.removeEventListener("resize", updateEdges);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [updateEdges]);

  return { containerRef, onMouseMove, onMouseLeave, edges };
}
