// Shown while the page streams in. It reaches the browser before the page has
// checked who is asking, so it is shapes only: no words at all, not even in
// this file. Laid out like the page: a header, a narrow list beside a wide
// panel with a few bubbles and a box at the bottom. The shimmer (.dd-skeleton)
// stops for prefers-reduced-motion.

const LIST = [0, 1, 2, 3, 4];
const BUBBLES = [0, 1, 2];

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
      <div aria-hidden className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        <div className="space-y-2">
          {LIST.map((i) => (
            <div key={i} className="dd-skeleton h-12 rounded-xl" />
          ))}
        </div>
        <div className="space-y-4 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft">
          {BUBBLES.map((i) => (
            <div key={i} className="space-y-2">
              <div className="ml-auto dd-skeleton h-8 w-1/2 rounded-2xl" />
              <div className="dd-skeleton h-20 w-full rounded-2xl" />
            </div>
          ))}
          <div className="dd-skeleton h-14 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
