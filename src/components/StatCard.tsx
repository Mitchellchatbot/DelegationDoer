"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

// Colorful, animated stat tile. Number counts up from 0 on mount via GSAP,
// and the card itself rises into place. Tones constrained to the
// blue→indigo→violet→purple family.

type Tone = "blue" | "indigo" | "violet" | "purple";

const TONES: Record<Tone, { ring: string; bg: string; iconBg: string; iconText: string }> = {
  blue:   { ring: "ring-blue-400/30",   bg: "from-blue-100 to-blue-50",     iconBg: "bg-blue-500 text-white",   iconText: "text-blue-600" },
  indigo: { ring: "ring-indigo-400/30", bg: "from-indigo-100 to-indigo-50", iconBg: "bg-indigo-500 text-white", iconText: "text-indigo-600" },
  violet: { ring: "ring-violet-400/30", bg: "from-violet-100 to-violet-50", iconBg: "bg-violet-500 text-white", iconText: "text-violet-600" },
  purple: { ring: "ring-purple-400/30", bg: "from-purple-100 to-purple-50", iconBg: "bg-purple-500 text-white", iconText: "text-purple-600" }
};

export function StatCard({
  label, value, icon, tone = "blue", subtitle, delay = 0
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: Tone;
  subtitle?: string;
  delay?: number;
}) {
  const t = TONES[tone];
  const cardRef = useRef<HTMLDivElement>(null);
  const numberRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      // Entry: rise + scale-in.
      if (cardRef.current) {
        gsap.from(cardRef.current, {
          y: 14,
          scale: 0.96,
          opacity: 0,
          duration: 0.55,
          delay,
          ease: "power3.out"
        });
      }

      // Count-up. Animate a tween proxy and write into the DOM each frame.
      if (numberRef.current) {
        const proxy = { v: 0 };
        gsap.to(proxy, {
          v: value,
          duration: 1.0,
          delay: delay + 0.1,
          ease: "power2.out",
          onUpdate: () => {
            if (numberRef.current) {
              numberRef.current.textContent = Math.round(proxy.v).toString();
            }
          }
        });
      }

      // Idle wiggle on the icon. Subtle so it doesn't get annoying.
      if (iconRef.current) {
        gsap.to(iconRef.current, {
          rotate: 3,
          duration: 2,
          delay,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut"
        });
      }
    });
    return () => ctx.revert();
  }, [value, delay]);

  return (
    <div
      ref={cardRef}
      className={`relative overflow-hidden rounded-2xl border border-white/40 ring-1 ${t.ring} shadow-soft hover:shadow-lift transition-all bg-gradient-to-br ${t.bg} p-4 hover:-translate-y-0.5 duration-200`}
    >
      <div className="flex items-center gap-2.5">
        <div ref={iconRef} className={`w-9 h-9 rounded-xl grid place-items-center shadow-sm ${t.iconBg}`}>
          {icon}
        </div>
        <div className="text-xs font-medium text-ink/70">{label}</div>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span ref={numberRef} className="text-3xl font-semibold tabular-nums text-ink">0</span>
        {subtitle && <span className="text-[11px] text-ink/60">{subtitle}</span>}
      </div>
    </div>
  );
}
