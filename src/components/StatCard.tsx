"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/utils";

// KPI tile — clean white card with a thin colored top accent bar and a
// pastel icon chip in the top-right corner. Label sits top-left next to
// an optional ⓘ tooltip; the value lives big underneath. Replaces the
// old heavy-gradient blue-only design with a tile that scans like a
// real metric card (cf. Allocation Assist dashboard KPIs) while keeping
// the brand blue as the default accent.

type Tone =
  | "blue" | "indigo" | "violet" | "purple"
  | "sky" | "teal" | "emerald" | "amber" | "rose" | "fuchsia";

const TONES: Record<Tone, {
  topBar: string;     // 2px top stripe
  iconBg: string;     // pastel icon chip
  iconFg: string;     // icon glyph color
  numberFg: string;   // number color (subtle wash of the accent)
}> = {
  blue:    { topBar: "bg-blue-500",    iconBg: "bg-blue-50",    iconFg: "text-blue-600",    numberFg: "text-blue-700"    },
  indigo:  { topBar: "bg-indigo-500",  iconBg: "bg-indigo-50",  iconFg: "text-indigo-600",  numberFg: "text-indigo-700"  },
  violet:  { topBar: "bg-violet-500",  iconBg: "bg-violet-50",  iconFg: "text-violet-600",  numberFg: "text-violet-700"  },
  purple:  { topBar: "bg-purple-500",  iconBg: "bg-purple-50",  iconFg: "text-purple-600",  numberFg: "text-purple-700"  },
  sky:     { topBar: "bg-sky-500",     iconBg: "bg-sky-50",     iconFg: "text-sky-600",     numberFg: "text-sky-700"     },
  teal:    { topBar: "bg-teal-500",    iconBg: "bg-teal-50",    iconFg: "text-teal-600",    numberFg: "text-teal-700"    },
  emerald: { topBar: "bg-emerald-500", iconBg: "bg-emerald-50", iconFg: "text-emerald-600", numberFg: "text-emerald-700" },
  amber:   { topBar: "bg-amber-500",   iconBg: "bg-amber-50",   iconFg: "text-amber-600",   numberFg: "text-amber-700"   },
  rose:    { topBar: "bg-rose-500",    iconBg: "bg-rose-50",    iconFg: "text-rose-600",    numberFg: "text-rose-700"    },
  fuchsia: { topBar: "bg-fuchsia-500", iconBg: "bg-fuchsia-50", iconFg: "text-fuchsia-600", numberFg: "text-fuchsia-700" }
};

export function StatCard({
  label, value, icon, tone = "blue", subtitle, delay = 0, info, valueLabel
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: Tone;
  subtitle?: string;
  delay?: number;
  // Optional tooltip text behind a small ⓘ next to the label, AA-style.
  info?: string;
  // Optional pre-formatted display string for the value (e.g. "21.9%",
  // "AED 48.6K"). When set we skip the count-up animation and render
  // this string verbatim under the label.
  valueLabel?: string;
}) {
  const t = TONES[tone];
  const numberRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const [tipOpen, setTipOpen] = useState(false);

  // Count-up + subtle icon wiggle. Skipped when a valueLabel is provided
  // since that's a pre-formatted string we don't want GSAP overwriting.
  useEffect(() => {
    const ctx = gsap.context(() => {
      if (numberRef.current && valueLabel == null) {
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
  }, [value, delay, valueLabel]);

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-soft hover:shadow-lift hover:-translate-y-0.5 transition-all duration-200">
      {/* Top accent bar — 2px stripe in the tone color. Mimics the AA
          KPI tiles where each metric is identified by its rail. */}
      <div className={cn("absolute inset-x-0 top-0 h-[3px]", t.topBar)} aria-hidden />

      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-[12.5px] font-medium text-ink/70">
              <span className="truncate">{label}</span>
              {info && (
                <button
                  type="button"
                  onMouseEnter={() => setTipOpen(true)}
                  onMouseLeave={() => setTipOpen(false)}
                  onFocus={() => setTipOpen(true)}
                  onBlur={() => setTipOpen(false)}
                  className="shrink-0 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-ink/40 hover:text-ink/70 transition-colors"
                  aria-label={info}
                >
                  <Info className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          <div
            ref={iconRef}
            className={cn(
              "w-9 h-9 rounded-xl grid place-items-center shrink-0 transition-colors",
              t.iconBg, t.iconFg
            )}
          >
            <span className="[&>svg]:w-[18px] [&>svg]:h-[18px]">{icon}</span>
          </div>
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          {valueLabel != null ? (
            <span className={cn("text-[34px] leading-none font-semibold tracking-tight tabular-nums", t.numberFg)}>
              {valueLabel}
            </span>
          ) : (
            <span
              ref={numberRef}
              className={cn("text-[34px] leading-none font-semibold tracking-tight tabular-nums", t.numberFg)}
            >0</span>
          )}
          {subtitle && (
            <span className="text-[11px] text-ink/55">{subtitle}</span>
          )}
        </div>

        {info && tipOpen && (
          <div role="tooltip" className="absolute left-5 right-5 top-12 z-20 px-3 py-2 rounded-lg bg-ink text-white text-[11px] leading-snug shadow-lift pointer-events-none">
            {info}
          </div>
        )}
      </div>
    </div>
  );
}
