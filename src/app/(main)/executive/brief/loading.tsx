// Shown while the page streams in. It reaches the browser before the page has
// checked who is asking, so it is shapes only: no words at all, not even in
// this file. Laid out like the page: a header, a dark summary card with three
// numbered lines, then two columns of cards. The shimmer (.dd-skeleton) stops
// for prefers-reduced-motion.

const LINES = [0, 1, 2];
const CARDS = [0, 1, 2, 3];

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
      <div aria-hidden className="space-y-3 rounded-2xl bg-slate-900 p-5 sm:p-6">
        <div className="h-3 w-40 rounded bg-white/10" />
        <div className="h-5 w-full max-w-xl rounded bg-white/10" />
        {LINES.map((i) => (
          <div key={i} className="flex items-center gap-2.5">
            <div className="h-5 w-5 shrink-0 rounded-full bg-white/10" />
            <div className="h-3.5 w-2/3 rounded bg-white/10" />
          </div>
        ))}
      </div>
      <div aria-hidden className="grid gap-5 lg:grid-cols-2">
        {CARDS.map((i) => (
          <div key={i} className="space-y-3 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft">
            <div className="dd-skeleton h-4 w-1/3 rounded" />
            <div className="dd-skeleton h-3 w-full rounded" />
            <div className="dd-skeleton h-3 w-5/6 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
