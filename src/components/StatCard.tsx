"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

// Colorful, animated stat tile. Number counts up from 0 on mount via GSAP,
// and the card itself rises into place. Tones constrained to the
// blue→indigo→violet→purple family.

type Tone = "blue" | "indigo" | "violet" | "purple";

// Tailwind's blue-100 reads as a saturated light blue, but indigo-100 /
// blue-100 / indigo-100 are noticeably paler — at the same step they look
// almost-white next to blue. Bumping the from-stop to 200 (and the to-stop
// to 100) gives every tone the same visual weight as the blue card.
const TONES: Record<Tone, { ring: string; bg: string; iconBg: string; iconText: string }> = {
  blue:   { ring: "ring-blue-400/40",   bg: "from-blue-200 to-blue-50",     iconBg: "bg-blue-500 text-white",   iconText: "text-blue-700" },
  indigo: { ring: "ring-indigo-400/40", bg: "from-indigo-200 to-indigo-50", iconBg: "bg-indigo-500 text-white", iconText: "text-indigo-700" },
  violet: { ring: "ring-indigo-400/40", bg: "from-indigo-200 to-indigo-50", iconBg: "bg-indigo-500 text-white", iconText: "text-indigo-700" },
  purple: { ring: "ring-blue-400/40", bg: "from-blue-200 to-blue-50", iconBg: "bg-blue-500 text-white", iconText: "text-blue-700" }
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
  const numberRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);

  // Note: no `gsap.from` for the card's entry — PageStagger already
  // animates the grid wrapper, and stacking another `from` on each card
  // caused a "flash correct, revert to wrong" bug under React strict mode
  // (the duplicate effect-run leaves the card stuck at opacity 0 / scale
  // < 1 on second mount). Count-up and icon wiggle stay because they're
  // `to` tweens — they don't have the same revert-to-bad-state issue.
  useEffect(() => {
    const ctx = gsap.context(() => {
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
