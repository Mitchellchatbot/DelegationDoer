"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragStart } from "@hello-pangea/dnd";

// Horizontal auto-scroll for @hello-pangea/dnd boards.
//
// Why this exists: the library only auto-scrolls the window and each
// Droppable's *closest* scrollable ancestor. On most of our boards that
// ancestor is the column's own `overflow-y-auto` list (the vertical cap that
// keeps the board's horizontal scrollbar reachable), so the outer
// `overflow-x-auto` board wrapper never gets driven, and you can't drag a card
// past the visible edge into an off-screen column. This hook adds the missing
// horizontal axis without touching the vertical caps.
//
// It tracks the pointer at the window level (the library uses synthetic
// mouse/touch sensors and listens there too, so we see the same
// coordinates) and, while a drag is in flight, nudges the container's
// `scrollLeft` once per animation frame when the pointer nears an edge.
// Scrolling via `scrollLeft` — never `transform` — keeps the
// position:fixed drag clone working (a transformed ancestor would become
// its containing block and break mid-flight positioning).
//
// Boards come in two layouts, chosen with `hitTest`:
// - Each column's list is the Droppable (hitTest: true, the default). The
//   wrapper is then a second scroll container the library can't see, so after
//   this hook scrolls, the library's idea of where every column sits is stale.
//   The hook works out the column from the live DOM instead: activeDroppableId
//   for the highlight, resolveDroppableId for the drop.
// - Each Droppable sits straight inside the wrapper, with its list scrolling
//   inside it (hitTest: false). The wrapper is then the Droppables' one scroll
//   container, which the library re-measures as it scrolls, so its own target,
//   highlight and drop animation are right and nothing needs correcting. Such a
//   board needs three props, all for the library's habits at the wrapper's
//   edges:
//   * autoScrollerOptions={{ disabled: true }} on the DragDropContext. The
//     library would otherwise drive the wrapper too, by the card's centre, and
//     stop as soon as that centre is pushed past the edge.
//   * ignoreContainerClipping on each Droppable. Clipped, a column scrolled
//     partly out of view counts only its visible sliver, and a card hanging over
//     half of that sliver wins it from the column the card is actually over.
//   * isDropDisabled={hiddenDroppableIds.has(id)}. Unclipped, a column
//     scrolled entirely out of view would still take a card held over the area
//     it sits under, like the sidebar.

const EDGE_PX = 60; // start scrolling within this many px of an edge
const MAX_SPEED_PX = 18; // max px per frame at the very edge
const NONE: ReadonlySet<string> = new Set();

export function useHorizontalDragAutoScroll({ hitTest = true }: { hitTest?: boolean } = {}) {
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
  // Droppables scrolled entirely out of the wrapper during a drag (hitTest:
  // false only; see the layouts above). Re-measured whenever the wrapper's
  // scroll moves, so the board re-renders only when a column enters or leaves.
  const [hiddenDroppableIds, setHiddenDroppableIds] = useState<ReadonlySet<string>>(NONE);
  const measuredScrollRef = useRef<number | null>(null);

  const measureHidden = useCallback(() => {
    const el = containerRef.current;
    if (hitTest || !el || el.scrollLeft === measuredScrollRef.current) return;
    measuredScrollRef.current = el.scrollLeft;
    const box = el.getBoundingClientRect();
    const hidden: string[] = [];
    el.querySelectorAll("[data-rfd-droppable-id]").forEach((d) => {
      const r = d.getBoundingClientRect();
      const id = d.getAttribute("data-rfd-droppable-id");
      if (id && (r.right <= box.left || r.left >= box.right)) hidden.push(id);
    });
    setHiddenDroppableIds((prev) =>
      prev.size === hidden.length && hidden.every((id) => prev.has(id)) ? prev : new Set(hidden)
    );
  }, [hitTest]);

  // Hit-test the live DOM for the droppable under the last pointer position.
  // Returns null for keyboard drags (no pointer) or when nothing resolves. The
  // portaled drag clone sits on document.body (not inside a droppable), so it's
  // skipped via closest() and we land on the column beneath.
  const hitTestDroppableId = useCallback((): string | null => {
    if (!hitTest || !sawPointerRef.current || typeof document === "undefined") return null;
    const hits = document.elementsFromPoint(pointerXRef.current, pointerYRef.current);
    for (const el of hits) {
      const drop = el instanceof Element ? el.closest("[data-rfd-droppable-id]") : null;
      const id = drop?.getAttribute("data-rfd-droppable-id");
      if (id) return id;
    }
    return null;
  }, [hitTest]);

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

    // Don't drive the board until a real pointer sample has landed this drag.
    // The refs persist across drags, so acting on them before the first
    // mousemove would scroll from the PREVIOUS drag's position — which
    // typically ended at an edge, exactly where the scroll math fires.
    if (!sawPointerRef.current) {
      rafRef.current = requestAnimationFrame(tick);
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
    if (hitTest) {
      const over = hitTestDroppableId();
      setActiveDroppableId((prev) => (prev === over ? prev : over));
    } else {
      measureHidden();
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [hitTest, hitTestDroppableId, measureHidden]);

  // Stop scrolling, and stop following the pointer, the moment the user lets
  // go. The library fixes its drop target then, starts its drop animation and
  // stops tracking scroll, but onDragEnd only fires once that animation ends,
  // up to about half a second later. Scrolling on until then moved the board
  // out from under the card: it flew to where its column had been, and the
  // hit-test picked whichever column had scrolled under the pointer by then,
  // or wherever the mouse had moved on to.
  const onRelease = useCallback(() => {
    draggingRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Escape cancels a mouse drag, and the card animates home: same reason.
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onRelease();
  }, [onRelease]);

  const onDragStart = useCallback((start?: DragStart) => {
    if (draggingRef.current) return;
    // Clear pointer state before the keyboard bail-out below: resolveDroppableId
    // and activeDroppableId both key off sawPointer, so a keyboard drag must
    // never inherit a `true` left behind by the previous mouse drag.
    sawPointerRef.current = false;
    setActiveDroppableId(null);
    // Keyboard drags too: they can't scroll the board, but they could still
    // step into a column hidden under the sidebar.
    measuredScrollRef.current = null;
    measureHidden();

    // Keyboard drags ('SNAP') never involve a pointer, and the library does NOT
    // cancel them on mousemove — getDraggingBindings cancels on mousedown /
    // mouseup / click / touchstart / resize / wheel only. So without this gate a
    // stray mouse nudge mid-drag would flip sawPointer and hand the drop target
    // to whatever column the idle cursor happens to rest over, which on the
    // tasks board means a silent reassign. Leave keyboard drags entirely to the
    // library: no pointer listeners, and no scroll loop.
    if (start?.mode === "SNAP") return;

    draggingRef.current = true;
    // Passive listeners — the library owns gesture suppression; we never
    // preventDefault (doing so would fight its touch sensor).
    window.addEventListener("mousemove", onPointerMove, { passive: true });
    window.addEventListener("touchmove", onPointerMove, { passive: true });
    window.addEventListener("mouseup", onRelease, true);
    window.addEventListener("touchend", onRelease, true);
    window.addEventListener("touchcancel", onRelease, true);
    window.addEventListener("keydown", onKeyDown, true);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
  }, [onPointerMove, onRelease, onKeyDown, tick, measureHidden]);

  const onDragEnd = useCallback(() => {
    onRelease();
    setActiveDroppableId(null);
    setHiddenDroppableIds(NONE);
    window.removeEventListener("mousemove", onPointerMove);
    window.removeEventListener("touchmove", onPointerMove);
    window.removeEventListener("mouseup", onRelease, true);
    window.removeEventListener("touchend", onRelease, true);
    window.removeEventListener("touchcancel", onRelease, true);
    window.removeEventListener("keydown", onKeyDown, true);
  }, [onPointerMove, onRelease, onKeyDown]);

  // Resolve the droppable actually under the cursor at drop time. The library's
  // result.destination is computed from a droppable-position model that doesn't
  // account for our outer-wrapper horizontal scroll (that wrapper isn't the
  // droppables' registered scrollable — each column's own overflow-y-auto is),
  // so after auto-scroll it points at the pre-scroll column. We re-resolve from
  // the live DOM instead. Keyboard drags (no pointer) keep the library's
  // destination via the fallback, as does every drag when hitTest is off.
  const resolveDroppableId = useCallback(
    (fallback: string): string => hitTestDroppableId() ?? fallback,
    [hitTestDroppableId]
  );

  // Safety net: if the tree unmounts mid-drag (navigation, router.refresh)
  // onDragEnd may never fire — tear down listeners and the RAF loop.
  useEffect(() => onDragEnd, [onDragEnd]);

  return { containerRef, onDragStart, onDragEnd, resolveDroppableId, activeDroppableId, hiddenDroppableIds };
}
