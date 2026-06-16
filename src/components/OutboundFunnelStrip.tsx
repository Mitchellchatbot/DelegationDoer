import { ArrowRight, Skull } from "lucide-react";
import type { LeadStatus } from "@/lib/outbound-leads";

// Stage-distribution view of the lead funnel — matches the AA-style
// strip used on the FB Ads 2 page. Stages are cumulative: Warm is
// every lead that ever entered the funnel (counts of every status
// past warm flow back up since they all started as warm). Each card
// shows the count + the conversion % from the immediately previous
// stage.
//
// "Lost" sits off to the side as a parallel terminal state, not part
// of the linear funnel.

interface Props {
  counts: Record<LeadStatus, number>;
}

export function OutboundFunnelStrip({ counts }: Props) {
  // Cumulative counts — anyone who reached "booked" also counted as
  // "warm" at one point, so the funnel reads top-down without leaks.
  // success implies showed implies booked implies warm. no_show is a
  // terminal off-shoot but still came through booked.
  const everReachedWarm =
    counts.warm_lead + counts.booked + counts.showed + counts.no_show + counts.success + counts.lost;
  const everReachedBooked =
    counts.booked + counts.showed + counts.no_show + counts.success;
  const everReachedShowed =
    counts.showed + counts.success;
  const won = counts.success;

  const stages: Array<{
    label: string;
    count: number;
    prev: number | null;
    tone: { num: string; bar: string };
  }> = [
    {
      label: "Warm leads",
      count: everReachedWarm,
      prev: null,
      tone: { num: "text-amber-700",   bar: "bg-amber-500" }
    },
    {
      label: "Booked",
      count: everReachedBooked,
      prev: everReachedWarm,
      tone: { num: "text-sky-700",     bar: "bg-sky-500" }
    },
    {
      label: "Showed",
      count: everReachedShowed,
      prev: everReachedBooked,
      tone: { num: "text-indigo-700",  bar: "bg-indigo-500" }
    },
    {
      label: "Won",
      count: won,
      prev: everReachedShowed,
      tone: { num: "text-emerald-700", bar: "bg-emerald-500" }
    }
  ];

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
            {counts.lost} {counts.lost === 1 ? "lost" : "lost"}
          </div>
        )}
      </div>
      <div className="p-5">
        <div className="flex items-stretch gap-2 overflow-x-auto">
          {stages.map((s, i) => {
            const convPct = s.prev != null && s.prev > 0
              ? (s.count / s.prev) * 100
              : null;
            return (
              <div key={s.label} className="flex items-stretch gap-2 min-w-fit flex-1">
                <div className="flex-1 rounded-xl border border-slate-200 bg-white p-4 min-w-[130px]">
                  <div className={`h-[3px] -mt-4 -mx-4 mb-3 ${s.tone.bar}`} aria-hidden />
                  <div className="text-[10.5px] uppercase tracking-[0.16em] font-semibold text-ink/55">
                    {s.label}
                  </div>
                  <div className={`text-[28px] leading-none font-semibold tabular-nums mt-1.5 ${s.tone.num}`}>
                    {s.count}
                  </div>
                  {convPct != null && (
                    <div className="text-[11px] text-ink/55 mt-2 tabular-nums">
                      {convPct.toFixed(1)}% from {stages[i - 1].label.toLowerCase()}
                    </div>
                  )}
                </div>
                {i < stages.length - 1 && (
                  <ArrowRight className="self-center w-4 h-4 text-ink/25 shrink-0" aria-hidden />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
