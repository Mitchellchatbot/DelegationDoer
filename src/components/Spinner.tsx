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
              background: ["#2563EB", "#1e63ff", "#EC4899"][i]
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
