import type { TourPlacement } from "./steps";

// The guided tour's geometry, pure (no window, no DOM): where the tooltip goes and how far to scroll, from a measured
// anchor rect, the measured tooltip height and the viewport. ExecTour.tsx reads the numbers and calls these;
// src/lib/exec/ui/tour-geometry.test.ts pins them.
//
// The rule that matters: the tooltip never sits on the thing it points at when there is anywhere else to put it. Below
// or above (flipping when the preferred side has no room), else beside, else, for an anchor that fills the screen, the
// bottom edge, which keeps the anchor's top (its title) in view because tall anchors are scrolled to put their top
// there. Width is 340 px, narrower on a phone so a 16 px gutter is always left on both sides.

export interface TourRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TourViewport {
  width: number;
  height: number;
}

/** The tooltip's width on a wide screen. */
export const TOUR_TIP_MAX_W = 340;
/** The space the tooltip always keeps from the viewport's edges (the phone gutter). */
export const TOUR_GUTTER = 16;
/** The space between the tooltip and the anchor. */
export const TOUR_GAP = 12;
/** Padding drawn around the anchor by the spotlight. */
export const TOUR_PAD = 6;
/**
 * The top of the band an anchor is scrolled into: below DD's sticky top bar (top-3 + h-16 = 76 px) with room to spare.
 * An anchor scrolled under the bar would show the bar through the spotlight instead of itself.
 */
export const TOUR_SAFE_TOP = 96;

/** The tooltip's width for a viewport: 340 px, or the viewport less a gutter on each side. */
export function tipWidth(viewportWidth: number): number {
  return Math.max(0, Math.min(TOUR_TIP_MAX_W, viewportWidth - 2 * TOUR_GUTTER));
}

/** The anchor's rect grown by the spotlight's padding. */
export function padRect(r: TourRect, pad = TOUR_PAD): TourRect {
  return { top: r.top - pad, left: r.left - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
}

/** The part of a rect inside the viewport, or null when none of it is. */
export function visiblePart(r: TourRect, vp: TourViewport): TourRect | null {
  const top = Math.max(0, r.top);
  const left = Math.max(0, r.left);
  const bottom = Math.min(vp.height, r.top + r.height);
  const right = Math.min(vp.width, r.left + r.width);
  if (bottom <= top || right <= left) return null;
  return { top, left, width: right - left, height: bottom - top };
}

export interface TipPosition {
  top: number;
  left: number;
  width: number;
  /** Where it ended up: a side of the anchor, or "edge" when no side had room and it sits at the bottom of the screen. */
  placement: TourPlacement | "edge";
}

const ORDER: Readonly<Record<TourPlacement, readonly TourPlacement[]>> = {
  bottom: ["bottom", "top", "right", "left"],
  top: ["top", "bottom", "right", "left"],
  right: ["right", "left", "bottom", "top"],
  left: ["left", "right", "bottom", "top"]
};

/**
 * Where the tooltip goes for an anchor (the spotlight's rect, in viewport coordinates), a tooltip `tipH` tall (measured,
 * never assumed) and a viewport. The first side in the preferred order with room for the whole tooltip, a gap from the
 * anchor and a gutter from the screen's edge wins; with none, the bottom edge.
 */
export function placeTip(anchor: TourRect, preferred: TourPlacement, tipH: number, vp: TourViewport): TipPosition {
  const width = tipWidth(vp.width);
  const clampLeft = (x: number) => Math.max(TOUR_GUTTER, Math.min(x, vp.width - width - TOUR_GUTTER));
  const clampTop = (y: number) => Math.max(TOUR_GUTTER, Math.min(y, vp.height - tipH - TOUR_GUTTER));
  const edge: TipPosition = { top: Math.max(TOUR_GUTTER, vp.height - tipH - TOUR_GUTTER), left: clampLeft((vp.width - width) / 2), width, placement: "edge" };

  // Only the part on screen matters: an anchor running off the bottom has no room "below" it, whatever its full height.
  const vis = visiblePart(anchor, vp);
  if (vis === null) return edge;
  const bottom = vis.top + vis.height;
  const right = vis.left + vis.width;
  const centred = clampLeft(vis.left + vis.width / 2 - width / 2);

  // Each side's spot, taken only when the whole tooltip lands inside the gutter on every edge.
  const insideX = (left: number) => left >= TOUR_GUTTER && left + width <= vp.width - TOUR_GUTTER;
  const insideY = (top: number) => top >= TOUR_GUTTER && top + tipH <= vp.height - TOUR_GUTTER;
  const spots: Readonly<Record<TourPlacement, { top: number; left: number; fits: boolean }>> = {
    bottom: { top: bottom + TOUR_GAP, left: centred, fits: insideY(bottom + TOUR_GAP) },
    top: { top: vis.top - TOUR_GAP - tipH, left: centred, fits: insideY(vis.top - TOUR_GAP - tipH) },
    right: { top: clampTop(vis.top), left: right + TOUR_GAP, fits: insideX(right + TOUR_GAP) },
    left: { top: clampTop(vis.top), left: vis.left - TOUR_GAP - width, fits: insideX(vis.left - TOUR_GAP - width) }
  };

  for (const side of ORDER[preferred]) {
    const spot = spots[side];
    if (spot.fits) return { top: spot.top, left: spot.left, width, placement: side };
  }
  return edge;
}

/**
 * How far to scroll the page (positive = down) to show an anchor, given the tooltip's height. Zero when the anchor is
 * already wholly inside the band under the top bar: yanking the page for something already in view is disorienting.
 * Otherwise the anchor and the tooltip below it are centred in the band when both fit; when they don't, the anchor's
 * top goes just under the bar (its title stays readable, and a tooltip at the bottom edge covers as little as it can).
 */
export function scrollDelta(anchor: TourRect, tipH: number, viewportHeight: number): number {
  const top = TOUR_SAFE_TOP;
  const bottom = viewportHeight - TOUR_GUTTER;
  const band = bottom - top;
  if (band <= 0) return 0;
  const anchorBottom = anchor.top + anchor.height;
  if (anchor.top >= top && anchorBottom <= bottom) return 0;
  const pair = anchor.height + TOUR_GAP + tipH;
  if (pair <= band) return anchor.top - (top + (band - pair) / 2);
  // Taller than the band: leave it if its top already sits in the band's upper quarter.
  if (anchor.height > band && anchor.top >= top && anchor.top <= top + band / 4) return 0;
  return anchor.top - top;
}

/**
 * The scroll the tour actually makes: scrollDelta, plus one case it can't see. An anchor already in view whose tooltip
 * has nowhere to go but the bottom edge (no room above, below or beside it, typical on a phone) gets its top lifted to
 * just under the bar, so the tooltip covers as little of it as possible.
 */
export function scrollFor(anchor: TourRect, preferred: TourPlacement, tipH: number, vp: TourViewport): number {
  const delta = scrollDelta(anchor, tipH, vp.height);
  if (delta !== 0) return delta;
  if (anchor.top > TOUR_SAFE_TOP && placeTip(anchor, preferred, tipH, vp).placement === "edge") return anchor.top - TOUR_SAFE_TOP;
  return 0;
}

/** The step to show for a raw ?step= value: an integer clamped to the steps, 0 for anything unreadable. */
export function clampStep(raw: string | null | undefined, count: number): number {
  if (count <= 0) return 0;
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, count - 1));
}
