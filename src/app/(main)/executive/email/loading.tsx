// Shown while the page streams in. It reaches the browser before the page has
// checked who is asking, so it is shapes only: no words at all, not even in
// this file. Laid out like the list page: a status strip, a tabbed list and
// a side column. The shimmer (.dd-skeleton) stops for prefers-reduced-motion.

const ROWS = [0, 1, 2, 3, 4, 5];
const TABS = [0, 1, 2, 3, 4];
const SIDE = [0, 1, 2];

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
      <div aria-hidden className="dd-skeleton h-14 rounded-2xl" />
      <div aria-hidden className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft">
          <div className="flex gap-3 border-b border-slate-100 px-4 py-3">
            {TABS.map((i) => (
              <div key={i} className="dd-skeleton h-4 w-20 rounded" />
            ))}
          </div>
          <div className="space-y-5 p-4">
            {ROWS.map((i) => (
              <div key={i} className="space-y-2">
                <div className="dd-skeleton h-3.5 w-3/4 rounded" />
                <div className="dd-skeleton h-3 w-1/2 rounded" />
                <div className="dd-skeleton h-3 w-full rounded" />
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-5">
          {SIDE.map((i) => (
            <div key={i} className="space-y-3 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft">
              <div className="dd-skeleton h-4 w-1/3 rounded" />
              <div className="dd-skeleton h-3 w-full rounded" />
              <div className="dd-skeleton h-3 w-2/3 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
