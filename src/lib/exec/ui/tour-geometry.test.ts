import { describe, expect, it } from "vitest";
import {
  TOUR_GAP,
  TOUR_GUTTER,
  TOUR_SAFE_TOP,
  TOUR_TIP_MAX_W,
  clampStep,
  padRect,
  placeTip,
  scrollDelta,
  scrollFor,
  tipWidth,
  visiblePart,
  type TourRect,
  type TourViewport
} from "@/components/exec/tour/geometry";
import type { TourPlacement } from "@/components/exec/tour/steps";

// The tour's pure geometry: the tooltip never covers its anchor when there is anywhere else to put it, it always keeps
// a 16 px gutter (phone width included), and the page scrolls only when the anchor isn't already in view.

const DESKTOP: TourViewport = { width: 1440, height: 900 };
const PHONE: TourViewport = { width: 390, height: 844 };
const TIP_H = 230;

const rect = (top: number, left: number, width: number, height: number): TourRect => ({ top, left, width, height });
const overlaps = (a: TourRect, b: TourRect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const tipRect = (p: { top: number; left: number; width: number }, h = TIP_H): TourRect => rect(p.top, p.left, p.width, h);

describe("tipWidth", () => {
  it("is 340 px, narrower on a small phone so a 16 px gutter is left on both sides", () => {
    expect(tipWidth(1440)).toBe(TOUR_TIP_MAX_W);
    expect(tipWidth(390)).toBe(340);
    expect(tipWidth(360)).toBe(328);
    expect(tipWidth(320)).toBe(288);
    expect(tipWidth(10)).toBe(0);
  });
});

describe("placeTip", () => {
  it("puts it under a short anchor at the top, centred on it, clear of it", () => {
    const header = padRect(rect(110, 300, 1100, 60));
    const pos = placeTip(header, "bottom", TIP_H, DESKTOP);
    expect(pos.placement).toBe("bottom");
    expect(pos.top).toBe(header.top + header.height + TOUR_GAP);
    expect(overlaps(tipRect(pos), header)).toBe(false);
  });

  it("flips above when there is no room below", () => {
    const low = rect(700, 400, 300, 120);
    const pos = placeTip(low, "bottom", TIP_H, DESKTOP);
    expect(pos.placement).toBe("top");
    expect(pos.top + TIP_H + TOUR_GAP).toBe(low.top);
    expect(overlaps(tipRect(pos), low)).toBe(false);
  });

  it("uses the measured height: a taller tooltip that no longer fits below flips", () => {
    const anchor = rect(500, 400, 300, 100);
    expect(placeTip(anchor, "bottom", 200, DESKTOP).placement).toBe("bottom");
    expect(placeTip(anchor, "bottom", 400, DESKTOP).placement).toBe("top");
    // With room neither below nor above, it goes beside.
    expect(placeTip(rect(400, 400, 300, 100), "bottom", 400, DESKTOP).placement).toBe("right");
  });

  it("goes beside a tall anchor that has room next to it (the feed card in the Overview's left column)", () => {
    const feed = rect(380, 300, 690, 1400);
    const pos = placeTip(feed, "right", TIP_H, DESKTOP);
    expect(pos.placement).toBe("right");
    expect(pos.left).toBe(300 + 690 + TOUR_GAP);
    expect(overlaps(tipRect(pos), visiblePart(feed, DESKTOP)!)).toBe(false);
  });

  it("falls back to the bottom edge for a full-width anchor that fills the screen, keeping the anchor's top in view", () => {
    const card = rect(TOUR_SAFE_TOP, 16, PHONE.width - 32, 2000);
    const pos = placeTip(card, "bottom", TIP_H, PHONE);
    expect(pos.placement).toBe("edge");
    expect(pos.top).toBe(PHONE.height - TIP_H - TOUR_GUTTER);
    // The anchor's top (its title) stays uncovered.
    expect(pos.top).toBeGreaterThan(card.top + 200);
  });

  it("puts it at the bottom edge when the anchor is off screen altogether", () => {
    expect(placeTip(rect(-900, 10, 300, 200), "bottom", TIP_H, DESKTOP).placement).toBe("edge");
    expect(placeTip(rect(2000, 10, 300, 200), "top", TIP_H, DESKTOP).placement).toBe("edge");
  });

  it("only the visible part of an anchor counts: one running off the bottom has no room below", () => {
    const tall = rect(500, 100, 600, 1500);
    const pos = placeTip(tall, "bottom", TIP_H, DESKTOP);
    expect(pos.placement).toBe("top");
    expect(pos.top + TIP_H).toBeLessThanOrEqual(500);
  });

  it("at every size, keeps the gutter, and never overlaps the anchor unless it is at the edge", () => {
    const sides: TourPlacement[] = ["top", "bottom", "left", "right"];
    for (const vp of [DESKTOP, PHONE, { width: 320, height: 568 }, { width: 1024, height: 700 }]) {
      for (let top = -200; top <= vp.height + 100; top += 97) {
        for (let left = 0; left < vp.width; left += Math.max(40, Math.floor(vp.width / 7))) {
          for (const [w, h] of [[120, 40], [vp.width - 32, 90], [300, 600], [vp.width, 2000]]) {
            for (const side of sides) {
              const anchor = rect(top, left, Math.min(w, vp.width - left), h);
              const pos = placeTip(anchor, side, TIP_H, vp);
              expect(pos.left, `left gutter at ${vp.width}`).toBeGreaterThanOrEqual(TOUR_GUTTER);
              expect(pos.left + pos.width, `right gutter at ${vp.width}`).toBeLessThanOrEqual(vp.width - TOUR_GUTTER);
              expect(pos.top).toBeGreaterThanOrEqual(TOUR_GUTTER);
              if (TIP_H + 2 * TOUR_GUTTER <= vp.height) expect(pos.top + TIP_H).toBeLessThanOrEqual(vp.height - TOUR_GUTTER);
              const vis = visiblePart(anchor, vp);
              if (pos.placement !== "edge" && vis) expect(overlaps(tipRect(pos), vis), JSON.stringify({ vp, anchor, side, pos })).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe("scrollDelta", () => {
  it("doesn't move a page whose anchor is already in view", () => {
    expect(scrollDelta(rect(200, 0, 500, 200), TIP_H, 900)).toBe(0);
  });

  it("brings an anchor below the fold up so it and the tooltip under it sit in the band below the top bar", () => {
    const anchor = rect(1500, 0, 500, 200);
    const d = scrollDelta(anchor, TIP_H, 900);
    const after = anchor.top - d;
    expect(after).toBeGreaterThanOrEqual(TOUR_SAFE_TOP);
    expect(after + anchor.height + TOUR_GAP + TIP_H).toBeLessThanOrEqual(900 - TOUR_GUTTER);
  });

  it("scrolls back up to an anchor hidden under the sticky top bar", () => {
    const d = scrollDelta(rect(20, 0, 500, 100), TIP_H, 900);
    expect(d).toBeLessThan(0);
    expect(20 - d).toBeGreaterThanOrEqual(TOUR_SAFE_TOP);
  });

  it("puts an anchor that fits, but not with the tooltip under it, just under the top bar", () => {
    const anchor = rect(1200, 0, 500, 600);
    expect(anchor.top - scrollDelta(anchor, TIP_H, 900)).toBe(TOUR_SAFE_TOP);
  });

  it("puts a tall anchor's top just under the top bar, and leaves one whose top is already near there", () => {
    expect(rect(1600, 0, 500, 3000).top - scrollDelta(rect(1600, 0, 500, 3000), TIP_H, 900)).toBe(TOUR_SAFE_TOP);
    expect(scrollDelta(rect(TOUR_SAFE_TOP + 40, 0, 500, 3000), TIP_H, 900)).toBe(0);
    expect(scrollDelta(rect(-400, 0, 500, 3000), TIP_H, 900)).toBe(-400 - TOUR_SAFE_TOP);
  });
});

describe("scrollFor", () => {
  it("lifts an in-view anchor whose tooltip could only go to the bottom edge (the tile grid on a phone)", () => {
    const tiles = rect(227, 24, 342, 470);
    expect(scrollDelta(tiles, TIP_H, PHONE.height)).toBe(0);
    expect(placeTip(tiles, "bottom", TIP_H, PHONE).placement).toBe("edge");
    const d = scrollFor(tiles, "bottom", TIP_H, PHONE);
    expect(tiles.top - d).toBe(TOUR_SAFE_TOP);
    // Lifted, the tooltip at the bottom edge covers far less of it.
    const covered = (top: number) => Math.max(0, top + tiles.height - (PHONE.height - TOUR_GUTTER - TIP_H));
    expect(covered(tiles.top - d)).toBeLessThan(covered(tiles.top));
  });

  it("leaves an in-view anchor alone when the tooltip has a place beside it, and defers to scrollDelta otherwise", () => {
    expect(scrollFor(rect(150, 300, 600, 80), "bottom", TIP_H, DESKTOP)).toBe(0);
    expect(scrollFor(rect(150, 16, PHONE.width - 32, 120), "bottom", TIP_H, PHONE)).toBe(0);
    const below = rect(1500, 0, 500, 200);
    expect(scrollFor(below, "bottom", TIP_H, DESKTOP)).toBe(scrollDelta(below, TIP_H, DESKTOP.height));
  });
});

describe("clampStep and padRect", () => {
  it("reads ?step= as a clamped integer, 0 for anything unreadable", () => {
    expect(clampStep("3", 12)).toBe(3);
    expect(clampStep("99", 12)).toBe(11);
    expect(clampStep("-2", 12)).toBe(0);
    expect(clampStep("abc", 12)).toBe(0);
    expect(clampStep(null, 12)).toBe(0);
    expect(clampStep(undefined, 12)).toBe(0);
    expect(clampStep("2", 0)).toBe(0);
  });

  it("pads the spotlight around the anchor", () => {
    expect(padRect(rect(100, 50, 200, 40))).toEqual(rect(94, 44, 212, 52));
  });
});
