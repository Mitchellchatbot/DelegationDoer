// Shown while the page streams in. It reaches the browser before the page has
// checked who is asking, so it is shapes only: no words at all, not even in
// this file. Laid out like the page: a header, a title block, three number
// tiles, then a list beside a column of cards. The shimmer (.dd-skeleton)
// stops for prefers-reduced-motion.

const TILES = [0, 1, 2];
const ROWS = [0, 1, 2, 3, 4];
const CARDS = [0, 1, 2];

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
      <div aria-hidden className="space-y-2">
        <div className="dd-skeleton h-5 w-24 rounded" />
        <div className="dd-skeleton h-3 w-full max-w-xl rounded" />
      </div>
      <div aria-hidden className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {TILES.map((i) => (
          <div key={i} className="dd-skeleton h-24 rounded-2xl" />
        ))}
      </div>
      <div aria-hidden className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="space-y-5 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft">
          {ROWS.map((i) => (
            <div key={i} className="space-y-2">
              <div className="dd-skeleton h-3 w-1/2 rounded" />
              <div className="dd-skeleton h-3.5 w-full rounded" />
              <div className="dd-skeleton h-3 w-2/3 rounded" />
            </div>
          ))}
        </div>
        <div className="space-y-4">
          {CARDS.map((i) => (
            <div key={i} className="space-y-3 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft">
              <div className="dd-skeleton h-4 w-1/3 rounded" />
              <div className="dd-skeleton h-3 w-full rounded" />
              <div className="dd-skeleton h-3 w-5/6 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
