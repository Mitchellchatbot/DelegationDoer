"use client";

import { motion } from "framer-motion";

// Brief, subtle radial wash that plays once when the outbound dashboard
// shell mounts. Tinted to the brand accent (not a saturated purple) and
// kept low-opacity so it reads as a premium reveal against the light
// chrome. Pointer-events:none so it never blocks clicks. Auto-removes
// itself ~900ms in by fading to fully transparent.
//
// This pairs with the wipe in EnterOutboundDashboardButton — the wipe
// covers the navigation gap, then this overlay reveals the new shell
// from the center outward.

export function OutboundShellIntro() {
  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 1, scale: 0.6 }}
      animate={{ opacity: 0, scale: 2.2 }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-none fixed inset-0 z-[60] grid place-items-center"
    >
      <div
        className="w-[60vmin] h-[60vmin] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(6, 50, 112, 0.14) 0%, rgba(6, 50, 112, 0.0) 65%)"
        }}
      />
    </motion.div>
  );
}
