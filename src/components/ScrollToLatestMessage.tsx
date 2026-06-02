"use client";

import { useEffect } from "react";

// Thread messages render oldest-first (sent_at ASC), so on a long thread the
// newest reply sits far below the fold and the page opens scrolled to the
// oldest message. On mount, bring the newest message into view.
//
// The catch: email bodies (see EmailBody) start at 200px and grow for up to
// ~3s as images + remote CSS load, which keeps pushing the newest message
// down. So we re-scroll across that same settle window instead of scrolling
// once against a not-yet-settled layout — and bail the instant the user
// scrolls up, so we don't fight someone reading the history.
const SETTLE_MS = 3000;
const RESCROLL_INTERVAL_MS = 150;

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

    scroll();
    const poll = setInterval(scroll, RESCROLL_INTERVAL_MS);
    const stop = setTimeout(() => clearInterval(poll), SETTLE_MS);

    return () => {
      window.removeEventListener("wheel", onWheel);
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [targetId]);

  return null;
}
