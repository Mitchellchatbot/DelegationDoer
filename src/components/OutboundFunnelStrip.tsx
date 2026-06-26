"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight, Skull, Flame, CalendarCheck, UserCheck, FileSignature, Trophy,
  TrendingUp, TrendingDown
} from "lucide-react";
import type { LeadStatus } from "@/lib/outbound-leads";
import { cn } from "@/lib/utils";

// Stage-distribution view of the lead funnel. Stages are cumulative: Warm
// is every lead that ever entered the funnel (counts of every status past
// warm flow back up since they all started as warm). Each card shows the
// count + the conversion % from the immediately previous stage.
//
// The stage cards wear the "/home → Today's Focus" treatment: a soft-tinted
// icon chip + bold neutral count up top, label + sub beneath, and a 3D flip
// on hover/focus revealing a frosted-glass panel with the conversion detail.
//
// "Lost" sits off to the side as a parallel terminal state, not part of the
// linear funnel.

type Tone = "amber" | "sky" | "indigo" | "violet" | "emerald";

// Front icon chip (soft tint).
const TONE: Record<Tone, string> = {
  amber:   "bg-amber-50 text-amber-600",
  sky:     "bg-sky-50 text-sky-600",
  indigo:  "bg-indigo-50 text-indigo-600",
  violet:  "bg-violet-50 text-violet-600",
  emerald: "bg-emerald-50 text-emerald-600"
};
// Back-face row icon + value accents.
const TONE_ICON: Record<Tone, string> = {
  amber: "text-amber-500", sky: "text-sky-500", indigo: "text-indigo-500",
  violet: "text-violet-500", emerald: "text-emerald-500"
};
const TONE_VALUE: Record<Tone, string> = {
  amber: "text-amber-700", sky: "text-sky-700", indigo: "text-indigo-700",
  violet: "text-violet-700", emerald: "text-emerald-700"
};
// Frosted-glass back panel: a soft tone→white gradient + inset ring, keyed
// by the same tone. Mirrors the Today's Focus idiom.
const TONE_BACK_GLASS: Record<Tone, string> = {
  amber:   "from-amber-50/80 via-white/70 to-white/60 ring-amber-200/50",
  sky:     "from-sky-50/80 via-white/70 to-white/60 ring-sky-200/50",
  indigo:  "from-indigo-50/80 via-white/70 to-white/60 ring-indigo-200/50",
  violet:  "from-violet-50/80 via-white/70 to-white/60 ring-violet-200/50",
  emerald: "from-emerald-50/80 via-white/70 to-white/60 ring-emerald-200/50"
};

interface Stage {
  label: string;
  count: number;
  prev: number | null;
  tone: Tone;
  icon: React.ReactNode;
}

interface Props {
  counts: Record<LeadStatus, number>;
}

export function OutboundFunnelStrip({ counts }: Props) {
  // Cumulative counts — anyone who reached "booked" also counted as
  // "warm" at one point, so the funnel reads top-down without leaks.
  // success implies contract implies showed implies booked implies warm.
  // no_show is a terminal off-shoot but still came through booked.
  const everReachedWarm =
    counts.warm_lead + counts.booked + counts.showed + counts.no_show +
    counts.contract + counts.success + counts.lost;
  const everReachedBooked =
    counts.booked + counts.showed + counts.no_show + counts.contract + counts.success;
  const everReachedShowed =
    counts.showed + counts.contract + counts.success;
  const everReachedContract =
    counts.contract + counts.success;
  const won = counts.success;

  const stages: Stage[] = [
    { label: "Warm leads", count: everReachedWarm,     prev: null,              tone: "amber",   icon: <Flame className="w-4 h-4" /> },
    { label: "Booked",     count: everReachedBooked,   prev: everReachedWarm,   tone: "sky",     icon: <CalendarCheck className="w-4 h-4" /> },
    { label: "Showed",     count: everReachedShowed,   prev: everReachedBooked, tone: "indigo",  icon: <UserCheck className="w-4 h-4" /> },
    { label: "Contract",   count: everReachedContract, prev: everReachedShowed, tone: "violet",  icon: <FileSignature className="w-4 h-4" /> },
    { label: "Won",        count: won,                 prev: everReachedContract, tone: "emerald", icon: <Trophy className="w-4 h-4" /> }
  ];

  // One reduced-motion listener for the whole strip (passed to each card).
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  if (everReachedWarm === 0) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
            Funnel
          </div>
          <h2 className="text-[18px] font-semibold text-ink mt-0.5">Stage conversion</h2>
        </div>
        {counts.lost > 0 && (
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-[11.5px]">
            <Skull className="w-3 h-3" />
            {counts.lost} lost
          </div>
        )}
      </div>
      <div className="p-5">
        <div className="flex items-stretch gap-2 overflow-x-auto">
          {stages.map((s, i) => (
            <div key={s.label} className="flex items-stretch gap-2 min-w-fit flex-1">
              <FlipStage
                stage={s}
                prevLabel={i > 0 ? stages[i - 1].label : null}
                reduceMotion={reduceMotion}
              />
              {i < stages.length - 1 && (
                <ArrowRight className="self-center w-4 h-4 text-ink/25 shrink-0" aria-hidden />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Single funnel stage as a flip card: count on the front, the conversion
// detail on a frosted-glass reverse. Flips on hover and keyboard focus. The
// 3D + the staggered row reveal are inline-styled (no arbitrary CSS-property
// utilities) so it's self-contained and robust — mirrors Today's Focus.
function FlipStage({
  stage, prevLabel, reduceMotion
}: {
  stage: Stage;
  prevLabel: string | null;
  reduceMotion: boolean;
}) {
  const [flipped, setFlipped] = useState(false);

  const convPct = stage.prev != null && stage.prev > 0
    ? (stage.count / stage.prev) * 100
    : null;
  const dropped = stage.prev != null ? stage.prev - stage.count : null;
  const sub = prevLabel ? `from ${prevLabel.toLowerCase()}` : "Top of funnel";

  // Back-face rows (inner content; FlipStage lays them out + animates).
  const backRows: React.ReactNode[] = prevLabel != null
    ? [
        <>
          <span className={cn("shrink-0", TONE_ICON[stage.tone])}><TrendingUp className="w-3.5 h-3.5" /></span>
          <span className="text-[10.5px] font-medium text-ink/70 truncate flex-1 min-w-0">from {prevLabel.toLowerCase()}</span>
          <span className={cn("text-[12px] font-bold tabular-nums shrink-0", TONE_VALUE[stage.tone])}>
            {convPct != null ? `${convPct.toFixed(0)}%` : "—"}
          </span>
        </>,
        ...(dropped != null && dropped > 0
          ? [
              <>
                <span className="shrink-0 text-ink/35"><TrendingDown className="w-3.5 h-3.5" /></span>
                <span className="text-[10.5px] font-medium text-ink/70 truncate flex-1 min-w-0">didn&apos;t convert</span>
                <span className="text-[12px] font-bold tabular-nums shrink-0 text-ink/55">{dropped}</span>
              </>
            ]
          : [])
      ]
    : [
        <>
          <span className={cn("shrink-0", TONE_ICON[stage.tone])}><Flame className="w-3.5 h-3.5" /></span>
          <span className="text-[10.5px] font-medium text-ink/70 truncate flex-1 min-w-0">Entered the funnel</span>
          <span className={cn("text-[12px] font-bold tabular-nums shrink-0", TONE_VALUE[stage.tone])}>{stage.count}</span>
        </>
      ];

  return (
    <div
      tabIndex={0}
      onMouseEnter={() => setFlipped(true)}
      onMouseLeave={() => setFlipped(false)}
      onFocus={() => setFlipped(true)}
      onBlur={() => setFlipped(false)}
      style={{ perspective: 800 }}
      className="flex-1 min-w-[130px] rounded-xl outline-none"
    >
      <div
        style={{
          position: "relative",
          transformStyle: "preserve-3d",
          transition: reduceMotion ? undefined : "transform .42s cubic-bezier(.2,.7,.2,1)",
          transform: flipped ? "rotateY(180deg)" : undefined
        }}
      >
        {/* FRONT — count; in normal flow so it sets the card height. */}
        <div
          style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
          className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col"
        >
          <div className="flex items-center justify-between">
            <span className={cn("w-7 h-7 rounded-lg grid place-items-center shrink-0", TONE[stage.tone])}>
              {stage.icon}
            </span>
            <span className="text-[20px] font-bold tabular-nums text-ink leading-none">
              {stage.count}
            </span>
          </div>
          <div className="text-[12px] font-semibold text-ink leading-tight mt-2 truncate">
            {stage.label}
          </div>
          <div className="text-[10px] text-ink/45 leading-tight truncate tabular-nums">
            {convPct != null ? `${convPct.toFixed(1)}% ${sub}` : sub}
          </div>
        </div>

        {/* BACK — frosted glass panel; rows cascade in as the card turns. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: "rotateY(180deg)",
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden"
          }}
          className={cn(
            "rounded-xl px-3 py-2 overflow-hidden flex flex-col justify-center gap-1.5",
            "bg-gradient-to-br backdrop-blur-sm ring-1 ring-inset shadow-soft",
            TONE_BACK_GLASS[stage.tone]
          )}
        >
          {backRows.map((row, i) => (
            <div
              key={i}
              className="flex items-center gap-2 leading-tight"
              style={
                reduceMotion
                  ? undefined
                  : {
                      opacity: flipped ? 1 : 0,
                      transform: flipped ? "translateY(0)" : "translateY(4px)",
                      transition: "opacity .28s ease, transform .28s ease",
                      transitionDelay: flipped ? `${80 + i * 45}ms` : "0ms"
                    }
              }
            >
              {row}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
