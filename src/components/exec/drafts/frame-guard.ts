"use client";

import { useEffect, useState } from "react";

// The frame guard (P4 contract §3.13.3, L16): the draft actions render only
// in a top-level window. False on the server and until mounted, then
// window.top === window.self. A page framed by another site (the /api/exec
// routes already answer frame-ancestors 'none'; this covers the pages) shows
// the draft read-only and offers nothing to click.
export function useIsTopWindow(): boolean {
  const [isTop, setIsTop] = useState(false);
  useEffect(() => {
    try {
      setIsTop(typeof window !== "undefined" && window.top === window.self);
    } catch {
      // A cross-origin parent throws on window.top: that is a frame.
      setIsTop(false);
    }
  }, []);
  return isTop;
}
