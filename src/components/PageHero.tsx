import { cn } from "@/lib/utils";

// Page hero modeled after the Scaled.AI landing page:
//   [ small uppercase eyebrow in accent blue ]
//   [ big bold headline — accent-blue keyword(s) inline ]
//   [ dark subtitle paragraph ]
//
// Lives on a clean white card with a thin border, no gradient. Replaces
// the heavy lavender-gradient banners that used to sit at the top of
// every page.

type IconTone = "blue" | "indigo" | "teal" | "emerald" | "amber" | "rose" | "fuchsia" | "sky" | "violet";

const ICON_TONE: Record<IconTone, string> = {
  blue:    "bg-blue-50    text-blue-600    ring-blue-200/60",
  indigo:  "bg-indigo-50  text-indigo-600  ring-indigo-200/60",
  teal:    "bg-teal-50    text-teal-600    ring-teal-200/60",
  emerald: "bg-emerald-50 text-emerald-600 ring-emerald-200/60",
  amber:   "bg-amber-50   text-amber-600   ring-amber-200/60",
  rose:    "bg-rose-50    text-rose-600    ring-rose-200/60",
  fuchsia: "bg-fuchsia-50 text-fuchsia-600 ring-fuchsia-200/60",
  sky:     "bg-sky-50     text-sky-600     ring-sky-200/60",
  violet:  "bg-violet-50  text-violet-600  ring-violet-200/60"
};

// One meta entry — e.g. { count: 500, label: "unread", href: "/inbox" }.
// Rendered as part of a pipe-separated summary row underneath the
// headline, AA-style ("On the plate: 500 unread · 1 batch today · 109
// open vacancies →"). Items with hrefs become links; the trailing arrow
// only renders when at least one item is a link.
export interface HeroMetaItem {
  count: number | string;
  label: string;
  href?: string;
  tone?: IconTone;
}

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
  // Optional inline "on the plate" summary row. Prefixed by `metaLabel`
  // (default "On the plate:") and joined by middots.
  meta?: HeroMetaItem[];
  metaLabel?: string;
  // Visual density. "default" keeps the large landing-style hero used
  // across the main app. "compact" is a tighter, more enterprise scale
  // (smaller headline + chip + padding) opted into by the outbound
  // dashboard pages — additive, so existing callers are unaffected.
  density?: "default" | "compact";
}

const META_TONE: Record<IconTone, string> = {
  blue:    "text-blue-600    hover:text-blue-700",
  indigo:  "text-indigo-600  hover:text-indigo-700",
  teal:    "text-teal-600    hover:text-teal-700",
  emerald: "text-emerald-600 hover:text-emerald-700",
  amber:   "text-amber-600   hover:text-amber-700",
  rose:    "text-rose-600    hover:text-rose-700",
  fuchsia: "text-fuchsia-600 hover:text-fuchsia-700",
  sky:     "text-sky-600     hover:text-sky-700",
  violet:  "text-violet-600  hover:text-violet-700"
};

export function PageHero({
  eyebrow, headline, subtitle, icon, iconTone = "blue", className, trailing,
  meta, metaLabel = "On the plate:", density = "default"
}: Props) {
  const compact = density === "compact";
  return (
    <header
      className={cn(
        "border border-slate-200/70 bg-white shadow-soft",
        compact ? "rounded-2xl p-6" : "rounded-3xl p-8",
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
            "grid place-items-center shrink-0 ring-1",
            compact ? "w-11 h-11 rounded-xl" : "w-14 h-14 rounded-2xl",
            ICON_TONE[iconTone]
          )}>
            <span className={compact ? "[&>svg]:w-5 [&>svg]:h-5" : "[&>svg]:w-6 [&>svg]:h-6"}>{icon}</span>
          </div>
        )}
        <div className="flex-1 min-w-[280px]">
          <div className={cn(
            "text-[12px] uppercase font-semibold text-accent",
            compact ? "tracking-[0.14em]" : "tracking-[0.18em]"
          )}>
            {eyebrow}
          </div>
          <h1 className={cn(
            "mt-2 leading-[1.05] text-ink tracking-tight",
            compact ? "text-[28px] font-semibold" : "text-[40px] font-bold"
          )}>
            {headline.map((part, i) =>
              typeof part === "string"
                ? <span key={i}>{part}</span>
                : <span key={i} className="text-accent">{part.accent}</span>
            )}
          </h1>
          {subtitle && (
            <p className={cn(
              "mt-3 text-ink/65 max-w-2xl leading-relaxed",
              compact ? "text-[14px]" : "text-[16px]"
            )}>
              {subtitle}
            </p>
          )}
          {meta && meta.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink/65">
              <span className="text-ink/55">{metaLabel}</span>
              {meta.map((m, i) => {
                const tone = META_TONE[m.tone ?? iconTone];
                const content = (
                  <>
                    <span className="font-semibold tabular-nums">{m.count}</span>
                    <span className="ml-1">{m.label}</span>
                  </>
                );
                return (
                  <span key={i} className="inline-flex items-center">
                    {i > 0 && <span aria-hidden className="mx-1.5 text-ink/30">·</span>}
                    {m.href ? (
                      <a href={m.href} className={cn("inline-flex items-center transition-colors", tone)}>
                        {content}
                      </a>
                    ) : (
                      <span className="inline-flex items-center text-ink/75">{content}</span>
                    )}
                  </span>
                );
              })}
              {meta.some((m) => m.href) && (
                <span aria-hidden className={cn("ml-0.5", META_TONE[iconTone])}>→</span>
              )}
            </div>
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
