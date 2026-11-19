"use client";

import { Suspense, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Compass, RotateCcw } from "lucide-react";
import { chatAskHref } from "@/lib/exec/chat/ask-prefill";
import { cn } from "@/lib/utils";
import { clampStep, padRect, placeTip, scrollFor, type TourRect } from "./geometry";
import { TOUR_CHAT_PATH, TOUR_DONE_KEY, TOUR_HOME, TOUR_STEPS, tourHref, type TourStep } from "./steps";

// The assistant's guided tour, zero-dependency, after Scaled Sync's components/tour/Tour.tsx: state in the URL
// (?tour=1&step=N), anchors on [data-tour] attributes, one spotlight element with a huge spread shadow, the tooltip
// placed from its MEASURED height (geometry.ts), a scroll-settle poll, Esc / Left / Right, and a portal to <body>.
//
// Where it mounts: ExecHeader, which every exec page renders after its owner gate. NOT the segment layout: the layout
// reaches the browser before a page can answer a teammate with a 404, so it must stay a plain wrapper that never names
// the feature (route-files.test.ts). The header is the first thing that renders only for him, and it is on every page,
// so the tour is on every exec page and on no other DD page. A route change remounts it; the URL carries it across.
//
// SSR and frames: ExecTour and TourReplayButton render nothing until mounted in a top-level window, so the server HTML
// carries no tour control (a framed page gets none, as with every exec control, S2) and the router hooks below never
// run outside the browser. It is its own check rather than drafts/frame-guard's useIsTopWindow: the suite mocks that
// hook to true while rendering whole pages statically with no router.
//
// The overlay is portaled to <body>: DD's <main> is a z-10 stacking context under the z-30 top bar, so a fixed overlay
// inside it would sit under the bar. z-[1000] puts it over the bar, Radix dialogs (z-40/50), DD's own z-[100] modals
// and the Multitask layer (z-[999]). While it is open the page underneath is shown but can't be clicked (it still
// scrolls), so a stray click can't strand the tour half way.
//
// Once per browser: the first visit to /executive starts it, and it records that in localStorage the moment it starts
// (so closing the tab mid-way counts too) and again on every exit: Skip, Esc, Finish, "Ask the assistant about this",
// and falling past the last step. Storage that can't be read counts as already seen: never re-offered every load. No
// database row: the team shares his account across browsers, so per-browser is the right grain anyway. "Take the tour"
// in the header and "Replay tour" in Settings start it any time.
//
// "Ask the assistant about this" closes the tour and opens Chat with the step's question in the composer
// (?ask=, lib/exec/chat/ask-prefill.ts). It is never sent: he presses Send himself.

/** The steps, where the tour starts and where Ask hands over. */
export interface ExecTourConfig {
  steps: readonly TourStep[];
  home: string;
  chatPath: string;
}

const DEFAULT_CONFIG: ExecTourConfig = { steps: TOUR_STEPS, home: TOUR_HOME, chatPath: TOUR_CHAT_PATH };

/**
 * The tour's config. The app never provides it, so every page gets the defaults above; a visual test harness can wrap
 * real exec views in a provider that points the same steps at its own routes.
 */
export const ExecTourConfigContext = createContext<ExecTourConfig>(DEFAULT_CONFIG);

/** How long to wait for a step's anchor before skipping the step (a feature that's off, or no data). */
const TARGET_TIMEOUT_MS = 1600;
/** Upper bound on the scroll-settle poll: a smooth scroll takes ~300-500 ms. */
const SETTLE_MS = 900;
/** Consecutive unchanged frames that count as "the scroll has finished". */
const STABLE_FRAMES = 3;
/** The tooltip's height before it has been measured (first paint only). */
const ASSUMED_TIP_H = 230;

// Module state, which outlives the remount between pages within one page load:
//   sessionLatch   the tour has started itself or been closed in this page load, so it won't start itself again even
//                  if localStorage can't be written;
//   lastDirection  which way a step with no anchor is skipped: back when he pressed Back, so Back can get past it.
let sessionLatch = false;
let lastDirection: 1 | -1 = 1;

function storedAsSeen(): boolean {
  try {
    return window.localStorage.getItem(TOUR_DONE_KEY) !== null;
  } catch {
    return true;
  }
}

function markSeen(): void {
  sessionLatch = true;
  try {
    window.localStorage.setItem(TOUR_DONE_KEY, new Date().toISOString());
  } catch {
    // Storage blocked or full: the session latch still stops a second start in this page load.
  }
}

// null, never window.history.state: Next's app router then syncs its URL (useSearchParams) with no refetch and no
// remount; passing its own state makes it treat the call as internal and skip that (memory next-replacestate-na-gotcha).
function replaceUrl(href: string): void {
  try {
    window.history.replaceState(null, "", href);
  } catch {
    // A browser that refuses keeps the old URL.
  }
}

function pushUrl(href: string): void {
  try {
    window.history.pushState(null, "", href);
  } catch {
    // As above.
  }
}

/** The current address without the tour's two params (everything else, and the hash, kept). */
function withoutTourParams(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  params.delete("tour");
  params.delete("step");
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Another modal is up (a gate, a dialog): don't start on top of it; try again on a later visit. */
function otherModalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"][aria-modal="true"]') !== null;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

const rectOf = (r: DOMRect): TourRect => ({ top: r.top, left: r.left, width: r.width, height: r.height });

/** True once mounted in a top-level window: never on the server, in a static render, or in a frame. */
function useMountedTopWindow(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    try {
      setOk(window.top === window.self);
    } catch {
      // A cross-origin parent throws on window.top: that is a frame.
      setOk(false);
    }
  }, []);
  return ok;
}

// The header's launcher sits among the title's pills; P9 F25's 40 px tap target below sm, as the tabs.
const START_BUTTON =
  "inline-flex min-h-10 items-center gap-1 rounded-full border border-indigo-200 bg-white px-3 text-[11.5px] font-semibold text-indigo-700 transition-colors hover:border-indigo-300 hover:text-indigo-900 sm:min-h-0 sm:px-2.5 sm:py-0.5";
const REPLAY_BUTTON =
  "inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-700 shadow-soft hover:border-slate-300 hover:text-ink sm:min-h-0";
const TIP_BUTTON = "inline-flex min-h-10 items-center rounded-lg px-3 text-[12.5px] font-semibold transition-colors sm:min-h-0 sm:py-1.5";

/** Every exec page's tour: the header's "Take the tour" and, while ?tour=1, the overlay. Rendered by ExecHeader. */
export function ExecTour() {
  const config = useContext(ExecTourConfigContext);
  const ready = useMountedTopWindow();
  if (!ready) return null;
  // useSearchParams wants a Suspense boundary; the tour draws nothing until it resolves.
  return (
    <Suspense fallback={null}>
      <TourRunner config={config} />
    </Suspense>
  );
}

/** Settings' "Replay tour": back to the first step on the Overview. */
export function TourReplayButton() {
  const config = useContext(ExecTourConfigContext);
  const ready = useMountedTopWindow();
  if (!ready) return null;
  return <ReplayButton home={config.home} />;
}

function ReplayButton({ home }: { home: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      data-tour-replay
      onClick={() => {
        lastDirection = 1;
        router.push(tourHref(home, 0));
      }}
      className={REPLAY_BUTTON}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
      Replay tour
    </button>
  );
}

interface Layout {
  rect: TourRect;
  vw: number;
  vh: number;
}

function TourRunner({ config }: { config: ExecTourConfig }) {
  const { steps, home, chatPath } = config;
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const params = useSearchParams();

  const running = params?.get("tour") === "1" && steps.length > 0;
  const index = clampStep(params?.get("step"), steps.length);
  const step: TourStep | undefined = running ? steps[index] : undefined;
  const last = index === steps.length - 1;

  const titleId = useId();
  const bodyId = useId();
  const [layout, setLayout] = useState<Layout | null>(null);

  // The tooltip's real height, measured by a callback ref (it fires exactly when the node mounts and unmounts). The 1 px
  // threshold makes it converge instead of looping. Placement and the scroll both use it, never a guess.
  const [tipH, setTipH] = useState(ASSUMED_TIP_H);
  const tipHRef = useRef(ASSUMED_TIP_H);
  tipHRef.current = tipH;
  const tipObserver = useRef<ResizeObserver | null>(null);
  const measureTip = useCallback((el: HTMLDivElement | null) => {
    tipObserver.current?.disconnect();
    tipObserver.current = null;
    if (!el) return;
    const sync = () => setTipH((h) => (Math.abs(el.offsetHeight - h) > 1 ? el.offsetHeight : h));
    sync();
    tipObserver.current = new ResizeObserver(sync);
    tipObserver.current.observe(el);
  }, []);

  // A new step drops the previous anchor's rect during render (not in an effect), so no frame paints the spotlight on
  // the old element before it moves.
  const stepKey = `${pathname}#${index}#${running}`;
  const [syncedKey, setSyncedKey] = useState(stepKey);
  if (stepKey !== syncedKey) {
    setSyncedKey(stepKey);
    if (layout !== null) setLayout(null);
  }

  /** Show step i: on this page by rewriting the URL in place, on another by navigating there (replacing, not pushing,
   *  so the whole tour is one history entry and Back leaves it). */
  const goto = useCallback(
    (i: number) => {
      const next = steps[i];
      if (!next) return;
      lastDirection = i < index ? -1 : 1;
      const href = tourHref(next.path, i);
      if (next.path === pathname) replaceUrl(href);
      else router.replace(href);
    },
    [steps, index, pathname, router]
  );

  /** Close the tour: every exit marks it seen. With a question, open Chat with it pre-filled (never sent). */
  const close = useCallback(
    (ask?: string) => {
      markSeen();
      lastDirection = 1;
      const loc = window.location;
      replaceUrl(withoutTourParams(loc.pathname, loc.search, loc.hash));
      if (ask !== undefined) {
        router.push(chatAskHref(chatPath, ask));
        return;
      }
      // Focus goes back to the launcher at the top of the page rather than being dropped on <body>.
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-tour-start]")?.focus({ preventScroll: true }));
    },
    [chatPath, router]
  );

  const start = useCallback(() => {
    lastDirection = 1;
    const href = tourHref(home, 0);
    // On the Overview already: just add the params (no refetch). Elsewhere: go there.
    if (pathname === home) pushUrl(href);
    else router.push(href);
  }, [home, pathname, router]);

  // Starting itself: once per browser, on the Overview only (starting mid-page elsewhere would be disorienting), and not
  // on top of another modal. A tour on screen, however it started, counts as seen.
  useEffect(() => {
    if (running) {
      if (!sessionLatch) markSeen();
      return;
    }
    if (sessionLatch || pathname !== home || steps.length === 0) return;
    if (storedAsSeen()) {
      sessionLatch = true;
      return;
    }
    if (otherModalOpen()) return;
    markSeen();
    lastDirection = 1;
    replaceUrl(tourHref(home, 0));
  }, [running, pathname, home, steps.length]);

  // Find the step's anchor, then track it: one effect, so the listeners attach the moment the element is found (Scaled
  // Sync's note on why "locate" and "track" can't be split). A step on another page navigates there first; the remount
  // there picks the tour up from the URL.
  const navigatingTo = useRef<string | null>(null);
  useEffect(() => {
    if (!step) return;
    if (step.path !== pathname) {
      const href = tourHref(step.path, index);
      if (navigatingTo.current !== href) {
        navigatingTo.current = href;
        router.replace(href);
      }
      return;
    }
    navigatingTo.current = null;

    let cancelled = false;
    let el: Element | null = null;
    let ro: ResizeObserver | null = null;
    let timer: number | undefined;
    let lastKey = "";
    const started = Date.now();

    /** Publish the rect only when it moved, so the settle loop doesn't re-render every frame. True when unchanged. */
    const remeasure = (): boolean => {
      if (cancelled || !el) return true;
      const rect = padRect(rectOf(el.getBoundingClientRect()));
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const key = `${rect.top}|${rect.left}|${rect.width}|${rect.height}|${vw}|${vh}`;
      if (key === lastKey) return true;
      lastKey = key;
      setLayout({ rect, vw, vh });
      return false;
    };
    const sync = () => {
      remeasure();
    };

    const track = (found: Element) => {
      el = found;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const delta = scrollFor(padRect(rectOf(found.getBoundingClientRect())), step.placement ?? "bottom", tipHRef.current, viewport);
      if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: reducedMotion() ? "auto" : "smooth" });
      // Capture: a scroll inside any container moves the anchor too, and scroll events don't bubble.
      window.addEventListener("scroll", sync, { passive: true, capture: true });
      window.addEventListener("resize", sync);
      ro = new ResizeObserver(sync);
      ro.observe(found);
      // A smooth scroll fires no "done" event: poll until the rect stops moving, or the spotlight lands short.
      let stable = 0;
      const until = Date.now() + SETTLE_MS;
      const tick = () => {
        if (cancelled) return;
        stable = remeasure() ? stable + 1 : 0;
        if (stable < STABLE_FRAMES && Date.now() < until) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const find = () => {
      if (cancelled) return;
      const found = document.querySelector(step.target);
      if (found) {
        track(found);
        return;
      }
      if (Date.now() - started > TARGET_TIMEOUT_MS) {
        // No anchor: the feature is off or there's no data yet. Skip the step the way he was going; falling past the
        // last step finishes the tour.
        if (lastDirection < 0 && index > 0) goto(index - 1);
        else if (index < steps.length - 1) goto(index + 1);
        else close();
        return;
      }
      timer = window.setTimeout(find, 80);
    };
    find();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
      ro?.disconnect();
    };
  }, [step, pathname, index, goto, close, router, steps.length]);

  // Esc closes; Right is Next (Finish on the last step); Left is Back. Arrows are left alone in a text field.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (isEditable(e.target)) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (last) close();
        else goto(index + 1);
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        goto(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, index, last, goto, close]);

  // Focus moves into the tooltip (its main button) as each step appears, so the dialog is announced and Enter goes on.
  const nextRef = useRef<HTMLButtonElement>(null);
  const shown = running && step !== undefined && layout !== null;
  useEffect(() => {
    if (shown) nextRef.current?.focus({ preventScroll: true });
  }, [shown, index]);

  // Tab stays inside the tooltip while it is open (aria-modal).
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (items.length === 0) return;
    const first = items[0];
    const lastItem = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      first.focus();
    } else if (!e.currentTarget.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  };

  const launcher = (
    <button type="button" data-tour-start onClick={start} className={START_BUTTON}>
      <Compass className="h-3.5 w-3.5" aria-hidden />
      Take the tour
    </button>
  );

  if (!shown || !step || !layout) return launcher;

  const pos = placeTip(layout.rect, step.placement ?? "bottom", tipH, { width: layout.vw, height: layout.vh });
  const progress = `${((index + 1) / steps.length) * 100}%`;

  return (
    <>
      {launcher}
      {createPortal(
        <div
          data-exec-tour=""
          role="dialog"
          aria-modal="true"
          aria-label={`Guided tour, step ${index + 1} of ${steps.length}: ${step.title}`}
          aria-describedby={bodyId}
          onKeyDown={trapTab}
          className="fixed inset-0 z-[1000]"
        >
          {/* The page stays visible but takes no clicks while the tour is open (it still scrolls under the wheel). */}
          <div aria-hidden className="absolute inset-0" />
          {/* The cutout: ONE element with an enormous spread shadow, so moving it between anchors is one transition. */}
          <div
            aria-hidden
            data-tour-spotlight=""
            className="pointer-events-none fixed rounded-2xl shadow-[0_0_0_9999px_rgba(15,23,42,0.55)] ring-2 ring-indigo-400 transition-[top,left,width,height] duration-300 ease-out motion-reduce:transition-none"
            style={{ top: layout.rect.top, left: layout.rect.left, width: layout.rect.width, height: layout.rect.height }}
          />
          <div
            ref={measureTip}
            data-tour-tip={pos.placement}
            className="fixed overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-lift transition-[top,left] duration-300 ease-out motion-reduce:transition-none"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <div aria-hidden className="h-1 bg-slate-100">
              <span className="block h-full bg-indigo-600 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: progress }} />
            </div>
            <div className="px-4 pb-3 pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">
                Step {index + 1} of {steps.length}
              </p>
              <h2 id={titleId} className="mt-1 text-[15px] font-semibold leading-snug text-ink">
                {step.title}
              </h2>
              <p id={bodyId} className="mt-1 text-[13px] leading-relaxed text-slate-600">
                {step.body}
              </p>
              {last && <p className="mt-2 text-[12px] text-muted">Replay it any time with Take the tour at the top of each page.</p>}
              <div className="mt-3 border-t border-slate-100 pt-1.5">
                <button
                  type="button"
                  data-tour-ask
                  onClick={() => close(step.ask)}
                  className="inline-flex min-h-10 items-center gap-1 text-[12.5px] font-semibold text-indigo-700 hover:text-indigo-900 sm:min-h-0 sm:py-1"
                >
                  Ask the assistant about this
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                {last ? (
                  <span />
                ) : (
                  <button type="button" data-tour-skip onClick={() => close()} className={cn(TIP_BUTTON, "px-1 text-slate-600 hover:text-ink")}>
                    Skip tour
                  </button>
                )}
                <div className="flex items-center gap-2">
                  {index > 0 && (
                    <button
                      type="button"
                      data-tour-back
                      onClick={() => goto(index - 1)}
                      className={cn(TIP_BUTTON, "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-ink")}
                    >
                      Back
                    </button>
                  )}
                  <button
                    ref={nextRef}
                    type="button"
                    data-tour-next
                    onClick={() => (last ? close() : goto(index + 1))}
                    className={cn(TIP_BUTTON, "bg-indigo-600 text-white hover:bg-indigo-700")}
                  >
                    {last ? "Finish" : "Next"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
