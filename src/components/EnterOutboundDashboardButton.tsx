"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Rocket, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

// Trigger button that pops a full-viewport purple wipe and routes into
// the (outbound) dashboard layout. The wipe is anchored to the click
// position so the transition feels like the dashboard physically grew
// out of the button, not a generic page change.
//
// Flow:
//   1. click → capture click coords → render an overlay element with
//      the new color, sized 0px at click point
//   2. animate it via clip-path circle expansion to cover the screen
//      (~600ms easeOut)
//   3. ~halfway through, router.push the new route — the next layout's
//      OutboundShellIntro plays as the wipe finishes, so the two
//      animations bridge across the navigation
//   4. on the new page, the overlay unmounts naturally because the
//      old route is gone

interface Props {
  // When true, render as a compact circular icon-only button suitable
  // for the topbar. Default is the full text+icon pill suitable for a
  // PageHero trailing slot.
  iconOnly?: boolean;
}

export function EnterOutboundDashboardButton({ iconOnly = false }: Props = {}) {
  const router = useRouter();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [origin, setOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // The overlay must portal to document.body. When the button lives
  // inside the Topbar (which uses backdrop-blur), that filter property
  // turns the Topbar into a containing block for `position: fixed`
  // descendants — so a `fixed inset-0` overlay rendered as a child of
  // the button only covers the Topbar's bounding rect instead of the
  // whole viewport. Portalling out escapes the containing block.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (transitioning) return;
    // Click coords in viewport space — also used by the overlay's
    // radial-gradient center so the brightest part of the wipe sits
    // exactly where the cursor landed.
    setOrigin({ x: e.clientX, y: e.clientY });
    setTransitioning(true);
    // Hand off to the new route mid-animation. 320ms in the wipe is
    // ~60% covered, giving the new layout room to mount and play its
    // OutboundShellIntro before the wipe fully clears.
    window.setTimeout(() => {
      router.push("/outbound-dashboard/facebook-ads");
    }, 320);
  }

  return (
    <>
      {iconOnly ? (
        <button
          ref={btnRef}
          onClick={onClick}
          disabled={transitioning}
          title="Enter Outbound Dashboard"
          aria-label="Enter Outbound Dashboard"
          className="group relative w-10 h-10 rounded-full inline-flex items-center justify-center text-white overflow-hidden shadow-lift hover:-translate-y-0.5 transition-transform disabled:opacity-70 disabled:cursor-wait shrink-0"
          style={{
            background: "linear-gradient(135deg, #6d28d9 0%, #4c1d95 100%)"
          }}
        >
          {/* Halo pulse to draw the eye to the icon — same "this does
              something special" cue as the shimmer on the pill version. */}
          <span
            aria-hidden
            className="absolute inset-0 rounded-full bg-violet-400/40 animate-ping opacity-60"
            style={{ animationDuration: "2.4s" }}
          />
          <Rocket className="w-4 h-4 relative" />
          <Sparkles className="w-2.5 h-2.5 absolute top-1.5 right-1.5 text-fuchsia-200" />
        </button>
      ) : (
        <button
          ref={btnRef}
          onClick={onClick}
          disabled={transitioning}
          className="group relative inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-[14px] font-semibold text-white overflow-hidden shadow-lift hover:-translate-y-0.5 transition-transform disabled:opacity-70 disabled:cursor-wait"
          style={{
            background: "linear-gradient(135deg, #6d28d9 0%, #4c1d95 100%)"
          }}
        >
          {/* Subtle shimmer that sweeps across the button on hover —
              sells the "this does something special" feel. */}
          <span
            aria-hidden
            className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent group-hover:translate-x-full transition-transform duration-700"
          />
          <Rocket className="w-4 h-4 relative" />
          <span className="relative">Enter Outbound Dashboard</span>
          <Sparkles className="w-3.5 h-3.5 relative text-fuchsia-200" />
        </button>
      )}

      {mounted && createPortal(
        <AnimatePresence>
          {transitioning && (
            <motion.div
              key="outbound-wipe"
              initial={{ clipPath: `circle(0% at ${origin.x}px ${origin.y}px)` }}
              animate={{ clipPath: `circle(160% at ${origin.x}px ${origin.y}px)` }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              className="fixed inset-0 z-[100] pointer-events-none"
              style={{
                // Radial gradient anchored at the click point so the wipe
                // reads as light "blooming out" from the cursor, not a
                // flat sheet sliding in. Outer fades to the deep purple
                // of the new sidebar so the transition lands on the same
                // tone the user is about to see.
                background: `radial-gradient(circle at ${origin.x}px ${origin.y}px, #a855f7 0%, #7c3aed 35%, #3b0764 90%)`
              }}
            >
              <div className="absolute inset-0 grid place-items-center">
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.15, duration: 0.4 }}
                  className="text-white text-center"
                >
                  <div className="text-[10px] uppercase tracking-[0.3em] text-purple-200/90 mb-2">
                    Outbound mode
                  </div>
                  <div className="text-3xl font-bold">Launching dashboard…</div>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
