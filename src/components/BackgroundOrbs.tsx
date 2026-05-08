"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

// Reusable layer of slowly-drifting blurred radial gradient circles. Drop
// inside any positioned parent (relative/absolute/sticky) to add ambient
// "floaty water" decoration behind the content.
//
// Driven by GSAP timelines — each orb gets its own infinite yoyo on x/y
// with a per-orb duration + offset, so they never line up.

type Variant = "sidebar" | "canvas";

interface OrbSpec {
  size: number;
  color: string;
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  amplitude?: number;
  duration?: number;
  delay?: number;
}

// Blue → indigo → violet → purple only. No pink/emerald/amber/rose.
const SIDEBAR_ORBS: OrbSpec[] = [
  { size: 200, color: "rgba(99,102,241,0.45)",  top: "-40px",    left: "-60px",  amplitude: 18, duration: 13 },
  { size: 180, color: "rgba(99,102,241,0.42)",  top: "32%",      right: "-70px", amplitude: 22, duration: 17, delay: 1.2 },
  { size: 170, color: "rgba(59,130,246,0.40)",  bottom: "-50px", left: "-40px",  amplitude: 16, duration: 19, delay: 2.4 },
  { size: 140, color: "rgba(59,130,246,0.38)",  top: "55%",      left: "30%",    amplitude: 24, duration: 15, delay: 0.6 }
];

const CANVAS_ORBS: OrbSpec[] = [
  { size: 480, color: "rgba(99,102,241,0.18)",   top: "-100px",  right: "10%",   amplitude: 30, duration: 22 },
  { size: 420, color: "rgba(99,102,241,0.16)",   top: "30%",     left: "-100px", amplitude: 36, duration: 26, delay: 1.8 },
  { size: 380, color: "rgba(59,130,246,0.18)",   bottom: "10%",  right: "-80px", amplitude: 28, duration: 24, delay: 0.9 },
  { size: 340, color: "rgba(59,130,246,0.14)",   bottom: "-80px", left: "30%",   amplitude: 24, duration: 28, delay: 3 },
  { size: 320, color: "rgba(99,102,241,0.13)",   top: "60%",     left: "55%",    amplitude: 20, duration: 21, delay: 1.4 }
];

export function BackgroundOrbs({ variant = "canvas" }: { variant?: Variant }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const orbs = variant === "sidebar" ? SIDEBAR_ORBS : CANVAS_ORBS;

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    // GSAP context auto-cleans every tween/timeline created inside it on
    // unmount. Means we don't have to track each tl by ref.
    const ctx = gsap.context(() => {
      const elements = root.querySelectorAll<HTMLDivElement>("[data-orb]");
      elements.forEach((el, i) => {
        const spec = orbs[i];
        if (!spec) return;
        const amp = spec.amplitude ?? 20;
        const dur = spec.duration ?? 18;
        const delay = spec.delay ?? 0;

        // x and y as separate tweens with different durations gives each
        // orb a Lissajous-like wander (never repeats the same path twice
        // in a row), better than synced x/y keyframes.
        gsap.to(el, {
          x: amp,
          duration: dur,
          delay,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut"
        });
        gsap.to(el, {
          y: -amp * 0.7,
          duration: dur * 1.18,
          delay: delay * 0.5,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut"
        });
      });
    }, root);

    return () => ctx.revert();
  }, [orbs]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="absolute inset-0 overflow-hidden pointer-events-none"
    >
      {orbs.map((o, i) => (
        <div
          key={i}
          data-orb
          className="absolute rounded-full"
          style={{
            width: o.size,
            height: o.size,
            top: o.top,
            left: o.left,
            right: o.right,
            bottom: o.bottom,
            background: `radial-gradient(circle, ${o.color}, transparent 70%)`,
            filter: "blur(2px)",
            willChange: "transform"
          }}
        />
      ))}
    </div>
  );
}
