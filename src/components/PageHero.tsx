import { cn } from "@/lib/utils";

// Page hero modeled after the Scaled.AI landing page:
//   [ small uppercase eyebrow in accent blue ]
//   [ big bold headline — accent-blue keyword(s) inline ]
//   [ dark subtitle paragraph ]
//
// Lives on a clean white card with a thin border, no gradient. Replaces
// the heavy lavender-gradient banners that used to sit at the top of
// every page.

type IconTone = "blue" | "indigo" | "teal" | "emerald" | "amber" | "rose" | "fuchsia" | "sky";

const ICON_TONE: Record<IconTone, string> = {
  blue:    "bg-blue-50    text-blue-600    ring-blue-200/60",
  indigo:  "bg-indigo-50  text-indigo-600  ring-indigo-200/60",
  teal:    "bg-teal-50    text-teal-600    ring-teal-200/60",
  emerald: "bg-emerald-50 text-emerald-600 ring-emerald-200/60",
  amber:   "bg-amber-50   text-amber-600   ring-amber-200/60",
  rose:    "bg-rose-50    text-rose-600    ring-rose-200/60",
  fuchsia: "bg-fuchsia-50 text-fuchsia-600 ring-fuchsia-200/60",
  sky:     "bg-sky-50     text-sky-600     ring-sky-200/60"
};

interface Props {
  eyebrow: string;
  headline: Array<string | { accent: string }>;
  subtitle?: string;
  icon?: React.ReactNode;
  // Tints the icon chip — defaults to brand blue. Pages set this to
  // sprinkle color variety across the dashboard without changing the
  // overall white/blue palette.
  iconTone?: IconTone;
  className?: string;
  trailing?: React.ReactNode;
}

export function PageHero({
  eyebrow, headline, subtitle, icon, iconTone = "blue", className, trailing
}: Props) {
  return (
    <header
      className={cn(
        "rounded-3xl border border-slate-200/70 bg-white p-8 shadow-soft",
        className
      )}
    >
      {/* Two rows now (was one). The icon + text block keeps the full
          width, so a long headline like "Sorted by priority" stays on
          a single line. The trailing action row (Health dashboard /
          Cross-client board / Import / Rescan / New) flows below at
          narrower widths instead of squeezing the headline column to
          one-word-per-line. At wide enough viewports the row absorbs
          back onto the top via flex-wrap. */}
      <div className="flex items-start gap-5 flex-wrap">
        {icon && (
          <div className={cn(
            "w-14 h-14 rounded-2xl grid place-items-center shrink-0 ring-1",
            ICON_TONE[iconTone]
          )}>
            <span className="[&>svg]:w-6 [&>svg]:h-6">{icon}</span>
          </div>
        )}
        <div className="flex-1 min-w-[280px]">
          <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent">
            {eyebrow}
          </div>
          <h1 className="mt-2 text-[40px] leading-[1.05] font-bold text-ink tracking-tight">
            {headline.map((part, i) =>
              typeof part === "string"
                ? <span key={i}>{part}</span>
                : <span key={i} className="text-accent">{part.accent}</span>
            )}
          </h1>
          {subtitle && (
            <p className="mt-3 text-[16px] text-ink/65 max-w-2xl leading-relaxed">
              {subtitle}
            </p>
          )}
        </div>
        {trailing && (
          <div className="shrink-0 w-full lg:w-auto flex flex-wrap items-center gap-2 lg:justify-end">
            {trailing}
          </div>
        )}
      </div>
    </header>
  );
}
