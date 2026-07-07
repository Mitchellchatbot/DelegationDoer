"use client";

import { useEffect, useState } from "react";

// SSR-safe "are we on a phone-width viewport" hook. Matches Tailwind's `md`
// breakpoint boundary: `(max-width: 767px)` is exactly one below `md` (768px),
// so this boolean and every `md:` class in the app flip at the same width.
//
// Defaults to `false` (the desktop branch) on the server and on the first
// client paint, then reconciles after mount — so there's no hydration
// mismatch. Consumers must tolerate a one-frame desktop→mobile correction.
//
// Used only where a CSS `md:` class can't win — namely the framer-motion
// inline `style.width` on the inbox split + tree (inline styles beat classes).
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return isMobile;
}
