"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Horizontal auto-scroll for @hello-pangea/dnd boards.
//
// Why this exists: the library auto-scrolls the window plus each
// Droppable's *closest* scrollable ancestor. Our Kanban columns wrap
// their Droppable in a per-column `overflow-y-auto` (the vertical cap
// that keeps the board's horizontal scrollbar reachable), so that
// vertical container is what the library scrolls — the outer
// `overflow-x-auto` board wrapper never gets driven, and you can't drag
// a card past the visible edge into an off-screen column. This hook adds
// the missing horizontal axis without touching the vertical caps.
//
// It tracks the pointer at the window level (the library uses synthetic
// mouse/touch sensors and listens there too, so we see the same
// coordinates) and, while a drag is in flight, nudges the container's
// `scrollLeft` once per animation frame when the pointer nears an edge.
// Scrolling via `scrollLeft` — never `transform` — keeps the
// position:fixed drag clone working (a transformed ancestor would become
// its containing block and break mid-flight positioning).

const EDGE_PX = 60; // start scrolling within this many px of an edge
const MAX_SPEED_PX = 18; // max px per frame at the very edge

export function useHorizontalDragAutoScroll() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const pointerXRef = useRef(0);
  const pointerYRef = useRef(0);
  // Whether a pointer (mouse/touch) is driving this drag. False for keyboard
  // drags, where we leave drop targeting entirely to the library.
  const sawPointerRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  // The column currently under the cursor, recomputed from the live DOM each
  // frame so the drag-over highlight tracks horizontal auto-scroll (the
  // library's own isDraggingOver doesn't — same stale-model reason as the drop
  // target; see resolveDroppableId). Null when no pointer drag is active.
  const [activeDroppableId, setActiveDroppableId] = useState<string | null>(null);

  // Hit-test the live DOM for the droppable under the last pointer position.
  // Returns null for keyboard drags (no pointer) or when nothing resolves. The
  // portaled drag clone sits on document.body (not inside a droppable), so it's
  // skipped via closest() and we land on the column beneath.
  const hitTestDroppableId = useCallback((): string | null => {
    if (!sawPointerRef.current || typeof document === "undefined") return null;
    const hits = document.elementsFromPoint(pointerXRef.current, pointerYRef.current);
    for (const el of hits) {
      const drop = el instanceof Element ? el.closest("[data-rfd-droppable-id]") : null;
      const id = drop?.getAttribute("data-rfd-droppable-id");
      if (id) return id;
    }
    return null;
  }, []);

  const onPointerMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!draggingRef.current) return;
    sawPointerRef.current = true;
    if ("touches" in e) {
      const t = e.touches[0];
      if (t) { pointerXRef.current = t.clientX; pointerYRef.current = t.clientY; }
    } else {
      pointerXRef.current = e.clientX;
      pointerYRef.current = e.clientY;
    }
  }, []);

  const tick = useCallback(() => {
    const el = containerRef.current;
    if (!el || !draggingRef.current) {
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
      // extremes.
      if (next !== el.scrollLeft) el.scrollLeft = next;
    }

    // Keep the drag-over highlight in sync with the real column under the
    // cursor — recomputed every frame so it stays correct while only the board
    // scrolls (cursor stationary). Dedupe so we re-render only on a change.
    const over = hitTestDroppableId();
    setActiveDroppableId((prev) => (prev === over ? prev : over));

    rafRef.current = requestAnimationFrame(tick);
  }, [hitTestDroppableId]);

  const onDragStart = useCallback(() => {
    if (draggingRef.current) return;
    draggingRef.current = true;
    sawPointerRef.current = false;
    setActiveDroppableId(null);
    // Passive listeners — the library owns gesture suppression; we never
    // preventDefault (doing so would fight its touch sensor).
    window.addEventListener("mousemove", onPointerMove, { passive: true });
    window.addEventListener("touchmove", onPointerMove, { passive: true });
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
  }, [onPointerMove, tick]);

  const onDragEnd = useCallback(() => {
    draggingRef.current = false;
    setActiveDroppableId(null);
    window.removeEventListener("mousemove", onPointerMove);
    window.removeEventListener("touchmove", onPointerMove);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [onPointerMove]);

  // Resolve the droppable actually under the cursor at drop time. The library's
  // result.destination is computed from a droppable-position model that doesn't
  // account for our outer-wrapper horizontal scroll (that wrapper isn't the
  // droppables' registered scrollable — each column's own overflow-y-auto is),
  // so after auto-scroll it points at the pre-scroll column. We re-resolve from
  // the live DOM instead. Keyboard drags (no pointer) keep the library's
  // destination via the fallback.
  const resolveDroppableId = useCallback(
    (fallback: string): string => hitTestDroppableId() ?? fallback,
    [hitTestDroppableId]
  );

  // Safety net: if the tree unmounts mid-drag (navigation, router.refresh)
  // onDragEnd may never fire — tear down listeners and the RAF loop.
  useEffect(() => onDragEnd, [onDragEnd]);

  return { containerRef, onDragStart, onDragEnd, resolveDroppableId, activeDroppableId };
}
