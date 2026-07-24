"use client";

import { motion } from "framer-motion";

// Friendly bouncing-dots loader. Three dots that ripple in sequence with a
// subtle scale + opacity loop. Sized via the `size` prop (dot diameter in px).

export function Spinner({
  size = 8,
  label,
  className
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div className={"inline-flex items-center gap-2 " + (className ?? "")}>
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="rounded-full"
            style={{
              width: size,
              height: size,
              background: ["#0a4099", "#063270", "#EC4899"][i]
            }}
            animate={{ scale: [0.6, 1, 0.6], opacity: [0.4, 1, 0.4] }}
            transition={{
              duration: 1,
              repeat: Infinity,
              ease: "easeInOut",
              delay: i * 0.18
            }}
          />
        ))}
      </div>
      {label && <span className="text-xs text-muted">{label}</span>}
    </div>
  );
}

// Big centered loader for full-page loading states (used in route loading.tsx).
export function PageLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 anim-fade-in">
      <Spinner size={10} />
      <span className="text-sm text-muted">{label}</span>
    </div>
  );
}

// Skeleton rows shaped like a real thread/account row (avatar + two lines),
// used for list-shaped route loading states so content doesn't pop in or
// jump layout once the data arrives — swap-in replacement for a bare
// PageLoader on list routes only (thread detail etc. keep the spinner).
export function ThreadListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1 p-3 anim-fade-in" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <div className="dd-skeleton w-9 h-9 rounded-full shrink-0" />
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="dd-skeleton h-2.5 rounded-full" style={{ width: i % 2 === 0 ? "45%" : "35%" }} />
            <div className="dd-skeleton h-2.5 rounded-full" style={{ width: i % 3 === 0 ? "70%" : "88%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
