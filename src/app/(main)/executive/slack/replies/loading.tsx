// Shown while a reply page streams in. It reaches the browser before the page has checked who is asking, so it is shapes
// only: no words at all, not even in this file. Laid out like the page: the header, then one card with a destination line,
// a text box and a row of buttons. The shimmer (.dd-skeleton) stops for prefers-reduced-motion.

const BUTTONS = [0, 1, 2];

export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-5">
      <div aria-hidden className="flex items-center gap-3">
        <div className="dd-skeleton h-10 w-10 shrink-0 rounded-xl" />
        <div className="space-y-2">
          <div className="dd-skeleton h-6 w-60 max-w-full rounded-lg" />
          <div className="dd-skeleton h-3 w-36 rounded" />
        </div>
      </div>
      <div aria-hidden className="space-y-3 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft sm:p-5">
        <div className="dd-skeleton h-5 w-40 rounded" />
        <div className="dd-skeleton h-3.5 w-2/3 rounded" />
        <div className="dd-skeleton h-32 w-full rounded-xl" />
        <div className="flex flex-wrap gap-2">
          {BUTTONS.map((i) => (
            <div key={i} className="dd-skeleton h-8 w-24 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
