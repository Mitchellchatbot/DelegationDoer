"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

// Wrapper that staggers its direct children into view with GSAP. Drop-in
// replacement for the CSS .animate-rise / inline animationDelay pattern.
//
//   <PageStagger>
//     <Hero />
//     <Stats />
//     <MainGrid />
//   </PageStagger>
//
// Each top-level child rises + fades on a shared timeline. Cards rendered
// inside a child won't be touched (preserves their own entry animations).

export function PageStagger({
  children,
  delay = 0,
  className
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const ctx = gsap.context(() => {
      gsap.from(Array.from(root.children) as HTMLElement[], {
        y: 16,
        opacity: 0,
        duration: 0.5,
        delay,
        stagger: 0.07,
        ease: "power3.out",
        // Drop the inline transform/opacity GSAP leaves behind after the
        // animation. Otherwise the leftover `transform: matrix(...)` makes
        // each child a containing block for position:fixed, which breaks
        // @hello-pangea/dnd drag clones nested inside (e.g. the kanban
        // on /my-tasks would let dragged cards "stick" mid-flight).
        clearProps: "transform,opacity"
      });
    }, root);
    return () => ctx.revert();
  }, [delay]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
