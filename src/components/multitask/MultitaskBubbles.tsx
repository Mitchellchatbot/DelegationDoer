"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BUBBLE_PADDING_TOP,
  BUBBLE_SIZE,
  BUBBLE_SPACING,
  EMPHASIZED_ACCELERATE,
  EMPHASIZED_DECELERATE,
  ESCAPE_VELOCITY,
  EXPAND_COLLAPSE_DURATION,
  FLING_TO_DISMISS_MIN_VELOCITY,
  STACK_OFFSET,
  SPRING_AFTER_FLING,
  SPRING_CHAIN,
  SPRING_EXPANDED_ROW,
  SPRING_STACK_SETTLE,
  SPRING_TO_TOUCH,
  STIFFNESS_HIGH,
  DAMPING_NO_BOUNCY,
  Spring1D,
  flingDistance,
} from "@/lib/bubble-physics";
import { MULTITASK_APPS, isSameSite } from "./multitask-apps";

const STORAGE_KEY = "multitask:bubbles:v1";
const EDGE_MARGIN = 12;
const DISMISS_MAGNET_RADIUS = 96;
/** Movement under this many px is a tap, not a drag. */
const TAP_SLOP = 8;

type Mode = "collapsed" | "expanded" | "hidden";

type Persisted = {
  x: number;
  y: number;
  activeId: string;
  mode: "collapsed" | "hidden";
};

/** Per-bubble physics state. Lives in a ref — never in React state. */
type BubbleBody = {
  id: string;
  x: Spring1D;
  y: Spring1D;
  scale: Spring1D;
};

export function MultitaskBubbles() {
  const [mode, setMode] = useState<Mode>("hidden");
  const [activeId, setActiveId] = useState<string>(MULTITASK_APPS[0].id);
  const [dragging, setDragging] = useState(false);
  const [overDismiss, setOverDismiss] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const bubbleEls = useRef<Map<string, HTMLElement>>(new Map());
  const bodies = useRef<BubbleBody[]>([]);
  const rafId = useRef<number | null>(null);
  const lastFrame = useRef<number>(0);
  /**
   * Set when the resting position came from a default rather than storage, so
   * a later resize can re-snap the stack to the real edge instead of leaving
   * it wherever a pre-layout viewport put it.
   */
  const needsReseed = useRef(false);
  /**
   * Where the stack was resting before it expanded. Expanding retargets every
   * bubble to a slot in the top row, which destroys the resting position — so
   * we stash it here and restore it on collapse, the way Android returns the
   * stack to its pre-expand spot rather than dropping it under the row.
   */
  const restPos = useRef<{ x: number; y: number } | null>(null);

  // Mutable gesture state. Kept out of React because it updates every
  // pointermove and must be readable synchronously inside the rAF loop.
  const gesture = useRef({
    active: false,
    grabDx: 0,
    grabDy: 0,
    pointerX: 0,
    pointerY: 0,
    startX: 0,
    startY: 0,
    moved: false,
    magnetized: false,
    samples: [] as { x: number; y: number; t: number }[],
  });

  // Mode needs to be readable from the rAF loop without re-subscribing it.
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /**
   * Collapsed: active app first, since in Android the most recent bubble leads
   * the stack. Expanded: fixed order — the row must not reshuffle under the
   * user's finger when they switch between apps.
   */
  const ordered = useMemo(() => {
    if (mode === "expanded") return MULTITASK_APPS;
    const active = MULTITASK_APPS.filter((a) => a.id === activeId);
    const rest = MULTITASK_APPS.filter((a) => a.id !== activeId);
    return [...active, ...rest];
  }, [activeId, mode]);
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;

  const activeApp = MULTITASK_APPS.find((a) => a.id === activeId) ?? MULTITASK_APPS[0];

  /**
   * True when this page can't share cookies with the framed app. Computed
   * after hydration since it depends on window.location.
   */
  const [crossSite, setCrossSite] = useState(false);
  useEffect(() => {
    setCrossSite(
      activeApp.embeddable && !isSameSite(activeApp.url, window.location.hostname)
    );
  }, [activeApp]);

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * A viewport narrower than this is assumed to be "not laid out yet" rather
   * than a real window. Effects can run before the browser has sized the
   * document (headless/offscreen tabs, an Electron window before its first
   * paint), and seeding the stack's position from a 0x0 viewport parks every
   * bubble in the top-left corner permanently.
   */
  const MIN_REAL_VIEWPORT = 200;

  const bounds = useCallback(() => {
    const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
    const vh = typeof window === "undefined" ? 800 : window.innerHeight;
    const minX = EDGE_MARGIN;
    const minY = EDGE_MARGIN + 48; // clear the topbar
    return {
      vw,
      vh,
      minX,
      minY,
      // Never let max fall below min — otherwise clamp() inverts and pins
      // everything to a corner.
      maxX: Math.max(minX, vw - BUBBLE_SIZE - EDGE_MARGIN),
      maxY: Math.max(minY, vh - BUBBLE_SIZE - EDGE_MARGIN),
      real: vw >= MIN_REAL_VIEWPORT && vh >= MIN_REAL_VIEWPORT,
    };
  }, []);

  /**
   * The expanded panel is full-bleed: it claims everything except the strip at
   * the top that the bubble row occupies, plus a hairline margin on the other
   * three sides so it still reads as a floating surface rather than a page.
   *
   * It deliberately does NOT follow the stack to the left or right edge the way
   * a phone-sized panel would — at this width there is no "side" left to be on,
   * so anchoring it would only make the expand animation lurch sideways.
   */
  const panelGeometry = useCallback(() => {
    const { vw, vh } = bounds();
    const rowY = BUBBLE_PADDING_TOP + 44;
    // Everything above this belongs to the bubble row.
    const top = rowY + BUBBLE_SIZE + BUBBLE_PADDING_TOP;
    const width = Math.max(0, vw - 2 * EDGE_MARGIN);
    const height = Math.max(0, vh - top - EDGE_MARGIN);
    return { width, height, left: EDGE_MARGIN, top, rowY };
  }, [bounds]);

  // -------------------------------------------------------------------------
  // Physics targets
  // -------------------------------------------------------------------------

  /**
   * Recomputes every bubble's spring target for the current mode/gesture. Called
   * once per frame before integrating, so a mode change mid-flight just
   * redirects the springs and preserves their velocity — which is why expanding
   * mid-fling doesn't stutter.
   */
  const applyTargets = useCallback(() => {
    const list = bodies.current;
    if (!list.length) return;
    const g = gesture.current;
    const b = bounds();

    if (modeRef.current === "expanded") {
      const { rowY, left, width } = panelGeometry();
      const count = orderedRef.current.length;
      const rowWidth = count * BUBBLE_SIZE + (count - 1) * BUBBLE_SPACING;
      const startX = left + Math.max(0, (width - rowWidth) / 2);
      orderedRef.current.forEach((app, i) => {
        const body = list.find((x) => x.id === app.id);
        if (!body) return;
        body.x.setConfig(SPRING_EXPANDED_ROW);
        body.y.setConfig(SPRING_EXPANDED_ROW);
        body.x.target = startX + i * (BUBBLE_SIZE + BUBBLE_SPACING);
        body.y.target = rowY;
        body.scale.target = 1;
      });
      return;
    }

    if (modeRef.current === "hidden") {
      list.forEach((body) => {
        body.scale.target = 0;
      });
      return;
    }

    // Collapsed: leader tracks the finger (or rests), followers chain off the
    // bubble in front of them.
    const leaderId = orderedRef.current[0]?.id;
    const leader = list.find((x) => x.id === leaderId);
    if (!leader) return;

    if (g.active) {
      if (g.magnetized) {
        // Snap hard into the dismiss target rather than tracking the finger.
        const { vw, vh } = b;
        leader.x.setConfig({ stiffness: STIFFNESS_HIGH, damping: DAMPING_NO_BOUNCY });
        leader.y.setConfig({ stiffness: STIFFNESS_HIGH, damping: DAMPING_NO_BOUNCY });
        leader.x.target = vw / 2 - BUBBLE_SIZE / 2;
        leader.y.target = vh - 92 - BUBBLE_SIZE / 2;
      } else {
        leader.x.setConfig(SPRING_TO_TOUCH);
        leader.y.setConfig(SPRING_TO_TOUCH);
        leader.x.target = clamp(g.pointerX - g.grabDx, b.minX, b.maxX);
        leader.y.target = clamp(g.pointerY - g.grabDy, b.minY, b.maxY);
      }
    }
    leader.scale.target = 1;

    // Chained followers: each trails the previous bubble's *current* position.
    const towardCenter = leader.x.value + BUBBLE_SIZE / 2 < b.vw / 2 ? 1 : -1;
    for (let i = 1; i < orderedRef.current.length; i++) {
      const body = list.find((x) => x.id === orderedRef.current[i].id);
      const prev = list.find((x) => x.id === orderedRef.current[i - 1].id);
      if (!body || !prev) continue;
      body.x.setConfig(SPRING_CHAIN);
      body.y.setConfig(SPRING_CHAIN);
      body.x.target = prev.x.value + towardCenter * STACK_OFFSET;
      body.y.target = prev.y.value;
      body.scale.target = 1;
    }
  }, [bounds, panelGeometry]);

  // -------------------------------------------------------------------------
  // rAF loop
  // -------------------------------------------------------------------------

  /** Advance the whole system by `dt` seconds and flush to the DOM. */
  const stepFrame = useCallback(
    (dt: number) => {
      applyTargets();

      const list = bodies.current;
      for (const body of list) {
        body.x.step(dt);
        body.y.step(dt);
        body.scale.step(dt);
      }

      // Write transforms straight to the DOM. Routing 3 springs x N bubbles
      // through React state would re-render the whole overlay 60x/sec.
      const count = list.length;
      orderedRef.current.forEach((app, i) => {
        const el = bubbleEls.current.get(app.id);
        const body = list.find((x) => x.id === app.id);
        if (!el || !body) return;
        el.style.transform = `translate3d(${body.x.value.toFixed(2)}px, ${body.y.value.toFixed(2)}px, 0) scale(${body.scale.value.toFixed(3)})`;
        el.style.zIndex = String(count - i);
        el.style.opacity = body.scale.value < 0.02 ? "0" : "1";
      });
    },
    [applyTargets]
  );

  useEffect(() => {
    if (!hydrated) return;

    const tick = (now: number) => {
      const dt = lastFrame.current ? (now - lastFrame.current) / 1000 : 1 / 60;
      lastFrame.current = now;
      stepFrame(dt);
      rafId.current = requestAnimationFrame(tick);
    };

    rafId.current = requestAnimationFrame(tick);
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      lastFrame.current = 0;
    };
  }, [stepFrame, hydrated]);

  /**
   * Dev-only inspection hook. rAF is throttled to zero in background and
   * headless tabs, so without a way to drive the clock manually the motion
   * can't be tested anywhere except a focused window.
   */
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !hydrated) return;
    (window as unknown as Record<string, unknown>).__multitaskDebug = {
      bodies: bodies.current,
      /** Advance `frames` steps of `dt` seconds without waiting on rAF. */
      pump: (frames = 60, dt = 1 / 60) => {
        for (let i = 0; i < frames; i++) stepFrame(dt);
        return bodies.current.map((b) => ({
          id: b.id,
          x: Number(b.x.value.toFixed(2)),
          y: Number(b.y.value.toFixed(2)),
          tx: Number(b.x.target.toFixed(2)),
          ty: Number(b.y.target.toFixed(2)),
          vx: Number(b.x.velocity.toFixed(1)),
          scale: Number(b.scale.value.toFixed(3)),
        }));
      },
      gesture: gesture.current,
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__multitaskDebug;
    };
  }, [stepFrame, hydrated]);

  // -------------------------------------------------------------------------
  // Init + persistence
  // -------------------------------------------------------------------------

  useEffect(() => {
    const b = bounds();
    let start: Persisted = {
      x: b.maxX,
      y: Math.round(b.vh * 0.55),
      activeId: MULTITASK_APPS[0].id,
      mode: "hidden",
    };
    // If the viewport isn't sized yet, the default above is meaningless —
    // flag it so the first real resize re-seeds the position.
    needsReseed.current = !b.real;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Persisted>;
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          needsReseed.current = false;
        }
        start = {
          x: typeof parsed.x === "number" ? clamp(parsed.x, b.minX, b.maxX) : start.x,
          y: typeof parsed.y === "number" ? clamp(parsed.y, b.minY, b.maxY) : start.y,
          activeId: MULTITASK_APPS.some((a) => a.id === parsed.activeId)
            ? (parsed.activeId as string)
            : start.activeId,
          mode: parsed.mode === "collapsed" ? "collapsed" : "hidden",
        };
      }
    } catch {
      /* corrupt JSON or storage disabled — fall back to defaults */
    }

    bodies.current = MULTITASK_APPS.map((app) => ({
      id: app.id,
      x: new Spring1D(start.x, SPRING_STACK_SETTLE),
      y: new Spring1D(start.y, SPRING_STACK_SETTLE),
      scale: new Spring1D(start.mode === "collapsed" ? 1 : 0, SPRING_EXPANDED_ROW),
    }));
    setActiveId(start.activeId);
    setMode(start.mode);
    setHydrated(true);
    // Intentionally mount-only: this seeds physics state, and re-running it
    // would teleport live bubbles back to their persisted position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(() => {
    const leader = bodies.current[0];
    if (!leader) return;
    // Don't write a position derived from an unlaid-out viewport — that would
    // poison storage for every future session.
    if (!bounds().real) return;
    // While expanded the springs point at the top row, which is not a resting
    // position — save the stashed one instead.
    const rest = restPos.current ?? { x: leader.x.target, y: leader.y.target };
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          x: Math.round(rest.x),
          y: Math.round(rest.y),
          activeId: activeIdRef.current,
          mode: modeRef.current === "hidden" ? "hidden" : "collapsed",
        } satisfies Persisted)
      );
    } catch {
      /* quota / private mode */
    }
  }, []);

  // Keep bubbles on-screen when the viewport changes.
  useEffect(() => {
    const onResize = () => {
      const b = bounds();
      if (!b.real) return;
      if (needsReseed.current) {
        // First time we've seen a real viewport — park the stack on the
        // right edge as if we'd known the size all along.
        needsReseed.current = false;
        const x = b.maxX;
        const y = clamp(Math.round(b.vh * 0.55), b.minY, b.maxY);
        for (const body of bodies.current) {
          body.x.snapTo(x);
          body.y.snapTo(y);
        }
        persist();
        return;
      }
      for (const body of bodies.current) {
        body.x.target = clamp(body.x.target, b.minX, b.maxX);
        body.y.target = clamp(body.y.target, b.minY, b.maxY);
      }
    };
    // ResizeObserver catches the initial layout pass, which fires no resize
    // event but is exactly when a 0x0 viewport becomes real.
    const ro = new ResizeObserver(onResize);
    ro.observe(document.documentElement);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [bounds, persist]);

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  const onPointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (modeRef.current !== "collapsed") return;
      const body = bodies.current.find((x) => x.id === id);
      if (!body) return;
      // Only the leader is draggable; the stack moves as a chain behind it.
      if (orderedRef.current[0]?.id !== id) return;

      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const g = gesture.current;
      g.active = true;
      g.grabDx = e.clientX - body.x.value;
      g.grabDy = e.clientY - body.y.value;
      g.pointerX = e.clientX;
      g.pointerY = e.clientY;
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.moved = false;
      g.magnetized = false;
      g.samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      setDragging(true);
    },
    []
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g.active) return;
    g.pointerX = e.clientX;
    g.pointerY = e.clientY;

    if (
      !g.moved &&
      Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TAP_SLOP
    ) {
      g.moved = true;
    }

    // Rolling 100ms window of samples — enough to get a stable velocity
    // without picking up the deceleration right before lift-off.
    const now = performance.now();
    g.samples.push({ x: e.clientX, y: e.clientY, t: now });
    while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();

    if (g.moved) {
      const { vw, vh } = bounds();
      const dist = Math.hypot(e.clientX - vw / 2, e.clientY - (vh - 92));
      const magnet = dist < DISMISS_MAGNET_RADIUS;
      if (magnet !== g.magnetized) {
        g.magnetized = magnet;
        setOverDismiss(magnet);
      }
    }
  }, [bounds]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      if (!g.active) return;
      g.active = false;
      setDragging(false);
      setOverDismiss(false);

      const leader = bodies.current[0];
      if (!leader) return;

      // Velocity in px/s from the sample window.
      const first = g.samples[0];
      const last = g.samples[g.samples.length - 1];
      const dtMs = Math.max(1, last.t - first.t);
      const vx = ((last.x - first.x) / dtMs) * 1000;
      const vy = ((last.y - first.y) / dtMs) * 1000;

      if (!g.moved) {
        restPos.current = { x: leader.x.target, y: leader.y.target };
        setMode("expanded");
        persist();
        return;
      }

      const b = bounds();

      if (g.magnetized || Math.hypot(vx, vy) > FLING_TO_DISMISS_MIN_VELOCITY) {
        g.magnetized = false;
        // Park the stack back on an edge before hiding. Otherwise we'd persist
        // the dismiss target's position and the bubbles would reappear
        // hovering over the bottom-centre of the screen next time.
        const restX = leader.x.value + BUBBLE_SIZE / 2 > b.vw / 2 ? b.maxX : b.minX;
        const restY = clamp(leader.y.value, b.minY, b.maxY);
        for (const body of bodies.current) {
          body.x.snapTo(restX);
          body.y.snapTo(restY);
        }
        setMode("hidden");
        persist();
        return;
      }

      // Project the fling. Past ESCAPE_VELOCITY the stack crosses to the far
      // edge; otherwise it falls back to whichever edge it's nearest.
      const projectedX = leader.x.value + flingDistance(vx);
      const center = projectedX + BUBBLE_SIZE / 2;
      const goRight =
        Math.abs(vx) > ESCAPE_VELOCITY ? vx > 0 : center > b.vw / 2;

      leader.x.setConfig(SPRING_AFTER_FLING);
      leader.y.setConfig(SPRING_AFTER_FLING);
      leader.x.target = goRight ? b.maxX : b.minX;
      // Carry the fling's velocity into the settle spring — this is what makes
      // a hard throw overshoot the edge and bounce back.
      leader.x.velocity = vx;
      leader.y.velocity = vy;
      leader.y.target = clamp(leader.y.value + flingDistance(vy), b.minY, b.maxY);

      persist();
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    },
    [bounds, persist]
  );

  // -------------------------------------------------------------------------
  // Keyboard: toggle + escape to collapse
  // -------------------------------------------------------------------------

  const toggle = useCallback(() => {
    setMode((m) => (m === "hidden" ? "collapsed" : "hidden"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Option+M, not Cmd+Shift+M — Chrome reserves Cmd+Shift+M for the
      // profile switcher and swallows it before the page ever sees it.
      // Matching on e.code keeps this working on non-QWERTY layouts, where
      // Option+M produces "µ" rather than "m".
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyM") {
        const el = e.target as HTMLElement | null;
        const typing =
          !!el &&
          (el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.isContentEditable);
        if (!typing) {
          e.preventDefault();
          toggle();
        }
      }
      if (e.key === "Escape" && modeRef.current === "expanded") {
        setMode("collapsed");
      }
    };
    // Lets any other component (e.g. the sidebar launcher) summon the stack
    // without threading state through a provider.
    const onToggleEvent = () => toggle();
    window.addEventListener("keydown", onKey);
    window.addEventListener("multitask:toggle", onToggleEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("multitask:toggle", onToggleEvent);
    };
  }, [toggle]);

  useEffect(() => {
    if (hydrated) persist();
  }, [mode, activeId, hydrated, persist]);

  // When collapsing, hand the springs back to the settle config so the stack
  // eases to the edge instead of staying on the loose expanded-row spring.
  useEffect(() => {
    if (mode !== "collapsed") return;
    const b = bounds();
    const leader = bodies.current[0];
    if (!leader) return;
    leader.x.setConfig(SPRING_STACK_SETTLE);
    leader.y.setConfig(SPRING_STACK_SETTLE);
    // Returning from expanded: go back to where the stack was, not to the
    // row slot the expand animation left the springs pointing at.
    const rest = restPos.current;
    restPos.current = null;
    leader.x.target = clamp(rest ? rest.x : leader.x.target, b.minX, b.maxX);
    leader.y.target = clamp(rest ? rest.y : leader.y.target, b.minY, b.maxY);
  }, [mode, bounds]);

  if (!hydrated) return null;

  const panel = panelGeometry();
  const expanded = mode === "expanded";

  return (
    <div
      ref={containerRef}
      className="pointer-events-none fixed inset-0 z-[999]"
      aria-hidden={mode === "hidden"}
    >
      {/* Scrim: only in expanded mode, and only to catch outside-clicks. */}
      <AnimatePresence>
        {expanded && (
          <motion.button
            type="button"
            aria-label="Collapse multitask panel"
            className="pointer-events-auto absolute inset-0 bg-ink/10 backdrop-blur-[1px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: EXPAND_COLLAPSE_DURATION }}
            onClick={() => setMode("collapsed")}
          />
        )}
      </AnimatePresence>

      {/* Expanded view. Duration + emphasized easing here, springs on the
          bubbles — matching how AOSP splits the two. */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="panel"
            className="pointer-events-auto absolute overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-lift"
            style={{
              left: panel.left,
              top: panel.top,
              width: panel.width,
              height: panel.height,
              transformOrigin: "top center",
            }}
            // Scale delta is small on purpose. 0.9 read fine on a 540px card,
            // but on a full-bleed panel the same ratio throws the edges ~70px
            // across the screen and looks like a lurch rather than a grow.
            initial={{ opacity: 0, scale: 0.98, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -10 }}
            transition={{
              duration: EXPAND_COLLAPSE_DURATION,
              ease: expanded ? EMPHASIZED_DECELERATE : EMPHASIZED_ACCELERATE,
            }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200/70 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <activeApp.icon className="h-4 w-4 shrink-0 text-accent" />
                <span className="truncate text-[13px] font-medium text-ink">
                  {activeApp.name}
                </span>
                <span className="truncate text-[11px] text-muted">{activeApp.url}</span>
              </div>
              <div className="flex items-center gap-1">
                <a
                  href={activeApp.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg p-1.5 text-muted hover:bg-surface2 hover:text-ink transition-colors"
                  title="Open in new tab"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
                <button
                  type="button"
                  onClick={() => setMode("collapsed")}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface2 hover:text-ink transition-colors"
                  title="Collapse (Esc)"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="relative h-[calc(100%-41px)] w-full bg-surface2">
              {activeApp.embeddable ? (
                <div className="flex h-full w-full flex-col">
                  {crossSite && <CrossSiteNotice app={activeApp} />}
                  <iframe
                    key={activeApp.id}
                    src={activeApp.url}
                    title={activeApp.name}
                    className={cn(
                      "w-full flex-1 border-0 bg-white",
                      dragging && "pointer-events-none"
                    )}
                    // No `sandbox` attribute on purpose. These are first-party
                    // apps we control, so it bought little, and every sandbox
                    // token that touches storage or navigation is a way for a
                    // login flow to break with no visible error.
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </div>
              ) : (
                <BlockedCard app={activeApp} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dismiss target */}
      <AnimatePresence>
        {dragging && (
          <motion.div
            className="absolute left-1/2 flex -translate-x-1/2 items-center justify-center"
            style={{ bottom: 64 }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: overDismiss ? 1.25 : 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: EXPAND_COLLAPSE_DURATION, ease: EMPHASIZED_DECELERATE }}
          >
            <div
              className={cn(
                "flex h-14 w-14 items-center justify-center rounded-full backdrop-blur-sm transition-colors",
                overDismiss ? "bg-urgent text-white" : "bg-ink/60 text-white"
              )}
            >
              <X className="h-6 w-6" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bubbles. Positioned entirely by the rAF loop — no inline transform
          here, or React would fight the physics engine every render. */}
      {ordered.map((app) => {
        const Icon = app.icon;
        const isLeader = ordered[0].id === app.id;
        const isActive = app.id === activeId;
        return (
          <div
            key={app.id}
            ref={(el) => {
              if (el) bubbleEls.current.set(app.id, el);
              else bubbleEls.current.delete(app.id);
            }}
            className="pointer-events-auto absolute left-0 top-0 will-change-transform"
            style={{ width: BUBBLE_SIZE, height: BUBBLE_SIZE }}
          >
            <button
              type="button"
              onPointerDown={(e) => onPointerDown(e, app.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onClick={() => {
                if (expanded) setActiveId(app.id);
              }}
              aria-label={`${app.name}${expanded ? "" : " — multitask bubble"}`}
              className={cn(
                "flex h-full w-full items-center justify-center rounded-full text-white shadow-lift outline-none",
                "ring-2 transition-[box-shadow,ring-color]",
                app.tone,
                expanded && isActive ? "ring-accent" : "ring-white/70",
                !expanded && !isLeader && "brightness-90",
                dragging ? "cursor-grabbing" : "cursor-grab",
                "focus-visible:ring-4 focus-visible:ring-accent/50"
              )}
              style={{ touchAction: "none" }}
            >
              <Icon className="h-6 w-6" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Shown when the parent page and the framed app aren't same-site. Without it,
 * a sign-in inside the frame just spins forever with nothing in the UI to
 * explain why.
 */
function CrossSiteNotice({ app }: { app: (typeof MULTITASK_APPS)[number] }) {
  const host = (() => {
    try {
      return new URL(app.url).hostname;
    } catch {
      return app.url;
    }
  })();
  return (
    <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
      <p className="text-[11px] leading-relaxed text-amber-900">
        This page isn&apos;t same-site with <span className="font-medium">{host}</span>,
        so the browser blocks its session cookie inside a frame — signing in here
        will hang. Use{" "}
        <a href={app.url} target="_blank" rel="noreferrer" className="underline">
          a real tab
        </a>{" "}
        until DelegationDoer is served from a scaledai.org host.
      </p>
    </div>
  );
}

function BlockedCard({ app }: { app: (typeof MULTITASK_APPS)[number] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warn/10 text-warn">
        <ShieldAlert className="h-6 w-6" />
      </div>
      <div className="text-[14px] font-medium text-ink">
        {app.name} can&apos;t be embedded
      </div>
      <p className="max-w-[380px] text-[12px] leading-relaxed text-muted">
        {app.blockedReason}
      </p>
      <a
        href={app.url}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-[12px] font-medium text-white hover:opacity-90 transition-opacity"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open {app.name} in a new tab
      </a>
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}
