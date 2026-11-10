"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

// The Email tab's bucket switcher. Every bucket's list is rendered on the
// server in the one page load and handed in as a panel; switching only
// shows another panel, so it costs no request (each page load is a gate
// check and an access-log row). Without JS the first panel shows.
//
// Keyboard: the tabs are a tablist; Left/Right/Home/End move between them.
//
// The strip wraps rather than scrolls (ui-9): on a phone the five tabs take
// two lines, so the selected one, and every other, is always in view, even
// when he arrives on a later bucket from an Overview link.

export interface BucketTab {
  key: string;
  label: string;
  /** null when there is no count to show: it couldn't be read, or nothing has been synced yet. */
  count: number | null;
}

export function BucketTabs({
  tabs,
  panels,
  initial
}: {
  tabs: readonly BucketTab[];
  panels: Readonly<Record<string, ReactNode>>;
  /** The bucket shown first (the page's ?bucket=, else the first). */
  initial: string;
}) {
  const first = tabs.some((t) => t.key === initial) ? initial : (tabs[0]?.key ?? "");
  const [active, setActive] = useState(first);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function move(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.key === active);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const key = tabs[next]?.key;
    if (key === undefined) return;
    setActive(key);
    refs.current[key]?.focus();
  }

  return (
    <div className="min-w-0">
      <div
        role="tablist"
        aria-label="Email buckets"
        onKeyDown={move}
        className="flex flex-wrap gap-x-1 border-b border-slate-100 px-3 pt-2"
      >
        {tabs.map((t) => {
          const selected = t.key === active;
          return (
            <button
              key={t.key}
              ref={(el) => {
                refs.current[t.key] = el;
              }}
              type="button"
              role="tab"
              id={`bucket-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`bucket-panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.key)}
              className={
                selected
                  ? // P9 F25: 40 px tall below sm.
                    "-mb-px min-h-10 shrink-0 border-b-2 border-indigo-600 px-2.5 pb-2 pt-1 text-[12.5px] font-semibold text-indigo-700 sm:min-h-0"
                  : "-mb-px min-h-10 shrink-0 border-b-2 border-transparent px-2.5 pb-2 pt-1 text-[12.5px] font-medium text-muted hover:text-ink sm:min-h-0"
              }
            >
              {t.label}
              <span
                className={
                  selected
                    ? "ml-1.5 rounded-full bg-indigo-100 px-1.5 py-px text-[11px] tabular-nums text-indigo-700"
                    : "ml-1.5 rounded-full bg-slate-100 px-1.5 py-px text-[11px] tabular-nums text-slate-600"
                }
              >
                {t.count === null ? "—" : t.count.toLocaleString("en-US")}
              </span>
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`bucket-panel-${t.key}`}
          aria-labelledby={`bucket-tab-${t.key}`}
          hidden={t.key !== active}
          className="min-w-0"
        >
          {panels[t.key]}
        </div>
      ))}
    </div>
  );
}
