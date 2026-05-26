import Link from "next/link";
import { Sunrise, Moon, CheckCircle2, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DayBookendStatus } from "@/lib/home-data";

// Pinned card at the top of /home that surfaces the two daily rituals.
// Two halves side-by-side: SOD on the left (sky), EOD on the right
// (indigo). Each half shows submission state + a deep-link to the
// existing /updates/sod or /updates/eod page (which still auto-pops
// the form via SodGate / EodTypeform). When both are submitted the
// card stays visible but collapses to a calm "All done for today"
// confirmation — never disappears so the user can re-open to amend.
//
// "Loudness" is time-of-day driven: morning leans into SOD; mid-day
// onwards leans into EOD. Single hour read on the server, no client
// state.

interface Props {
  status: DayBookendStatus;
  hourLocal: number;
}

export function DayBookends({ status, hourLocal }: Props) {
  const bothDone = status.sod.submitted && status.eod.submitted;
  // Loudness threshold: SOD loud until 11am, EOD loud from 4pm. In the
  // overlap (11am–4pm) both are calm — neither is yelling for the
  // user's attention at midday.
  const sodLoud = !status.sod.submitted && hourLocal < 11;
  const eodLoud = !status.eod.submitted && hourLocal >= 16;

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      {bothDone && (
        <div className="px-4 py-2 border-b border-emerald-100 bg-emerald-50/60 flex items-center gap-2 text-[12px] text-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          <span className="font-medium">All done for today.</span>
          <span className="text-emerald-700/70">Click either side to revisit.</span>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        <Half
          side="sod"
          href="/sod"
          loud={sodLoud}
          submittedAt={status.sod.submittedAt}
          icon={<Sunrise className="w-4 h-4" />}
          title="Start your day"
          prompt="Plan your day in 60 seconds"
          cta="Start day"
        />
        <Half
          side="eod"
          href="/eod"
          loud={eodLoud}
          submittedAt={status.eod.submittedAt}
          icon={<Moon className="w-4 h-4" />}
          title="Wrap your day"
          prompt="5 quick questions"
          cta="Submit EOD"
        />
      </div>
    </section>
  );
}

interface HalfProps {
  side: "sod" | "eod";
  href: string;
  loud: boolean;
  submittedAt: string | null;
  icon: React.ReactNode;
  title: string;
  prompt: string;
  cta: string;
}

function Half({ side, href, loud, submittedAt, icon, title, prompt, cta }: HalfProps) {
  const submitted = !!submittedAt;
  const tone = side === "sod"
    ? {
        // Sky for morning.
        bg: loud ? "bg-gradient-to-br from-sky-50 to-white" : "bg-white",
        text: "text-sky-700",
        ctaGradient: "linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)"
      }
    : {
        // Indigo for evening.
        bg: loud ? "bg-gradient-to-br from-indigo-50 to-white" : "bg-white",
        text: "text-indigo-700",
        ctaGradient: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)"
      };

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 p-3 transition-colors hover:bg-slate-50/60",
        tone.bg,
        // Muted halves are visually smaller so the loud one wins the eye
        // even with the same layout.
        !loud && !submitted && "opacity-75"
      )}
    >
      <div className={cn(
        "w-9 h-9 rounded-xl grid place-items-center shrink-0 shadow-sm",
        submitted ? "bg-emerald-100 text-emerald-700" : `bg-white ${tone.text}`
      )}>
        {submitted ? <CheckCircle2 className="w-4 h-4" /> : icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn(
          "text-[11px] uppercase tracking-[0.16em] font-semibold",
          submitted ? "text-emerald-700" : tone.text
        )}>
          {title}
        </div>
        <div className="text-[13px] font-semibold text-ink truncate">
          {submitted
            ? `Submitted at ${formatTime(submittedAt)}`
            : prompt}
        </div>
      </div>
      {submitted ? (
        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/60 font-semibold shrink-0">
          <CheckCircle2 className="w-3 h-3" />
          Done
        </span>
      ) : (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-[11px] font-semibold text-white shadow-sm shrink-0 rounded-full px-3 py-1.5 transition-all hover:-translate-y-0.5",
            !loud && "shadow-none"
          )}
          style={{ background: tone.ctaGradient }}
        >
          {cta}
          <ArrowRight className="w-3 h-3" />
        </span>
      )}
    </Link>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
