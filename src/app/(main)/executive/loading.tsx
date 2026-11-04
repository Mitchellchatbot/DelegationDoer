// Shown while the page streams in. It reaches the browser before the page has
// checked who is asking, so it is shapes only: no words at all. The shimmer
// (.dd-skeleton) already stops for prefers-reduced-motion.

const TILES = [0, 1, 2, 3, 4, 5];
const ROWS = [0, 1, 2, 3, 4];

export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-6">
      <div aria-hidden className="flex items-center gap-3">
        <div className="dd-skeleton h-10 w-10 shrink-0 rounded-xl" />
        <div className="space-y-2">
          <div className="dd-skeleton h-6 w-60 max-w-full rounded-lg" />
          <div className="dd-skeleton h-3 w-36 rounded" />
        </div>
      </div>
      <div aria-hidden className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {TILES.map((i) => (
          <div key={i} className="dd-skeleton h-24 rounded-2xl" />
        ))}
      </div>
      <div aria-hidden className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft">
          {ROWS.map((i) => (
            <div key={i} className="flex gap-3">
              <div className="dd-skeleton h-8 w-8 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="dd-skeleton h-3 w-2/3 rounded" />
                <div className="dd-skeleton h-3 w-full rounded" />
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-3 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft">
          {ROWS.map((i) => (
            <div key={i} className="dd-skeleton h-4 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
