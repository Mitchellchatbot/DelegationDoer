"use client";

import { useEffect } from "react";

// Thread messages render oldest-first (sent_at ASC), so on a long thread the
// newest reply sits far below the fold and the page opens scrolled to the
// oldest message. On mount, bring the newest message into view and keep it
// pinned while the layout settles.
//
// The catch: email bodies (see EmailBody) start at 200px and grow for up to
// ~3s as images + remote CSS load, which keeps pushing the newest message
// down. The old approach re-scrolled on a blind 150ms timer, so the viewport
// visibly hopped every tick — the target drifted as iframes above it grew,
// then got yanked back — which is the "shake" on load. Instead we re-pin from
// a ResizeObserver: it fires synchronously with the size change, before the
// browser paints, so the newest message stays put with no intermediate jump,
// and it only fires when something actually resizes (not on every render).
// We bail the instant the user scrolls up, so we don't fight someone reading
// the history, and we stop observing once the layout has settled so a stray
// late resize can't yank the viewport back.
const SETTLE_MS = 3000;

export function ScrollToLatestMessage({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;

    let following = true;
    // An explicit upward scroll means "let me read the history" — stop.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) following = false;
    };
    window.addEventListener("wheel", onWheel, { passive: true });

    const scroll = () => {
      if (following) el.scrollIntoView({ block: "start" });
    };

    // Initial landing on the newest message.
    scroll();

    // Re-pin only when the layout actually changes (email iframes growing as
    // images + remote CSS load). Running inside the observer keeps the scroll
    // in the same frame as the growth, so there's no visible hop.
    const ro = new ResizeObserver(scroll);
    ro.observe(document.body);

    const stop = setTimeout(() => ro.disconnect(), SETTLE_MS);

    return () => {
      window.removeEventListener("wheel", onWheel);
      ro.disconnect();
      clearTimeout(stop);
    };
  }, [targetId]);

  return null;
}
