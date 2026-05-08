"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Check, Clock, Minus, X, AlertTriangle, Plus, Bell, ArrowLeft, Image as ImageIcon, Focus, Coffee, Moon, Smile, Sparkles } from "lucide-react";
import { Countdown } from "@/components/Countdown";

interface WidgetTask {
  id: string;
  title: string;
  description?: string | null;
  priority: "low" | "medium" | "high" | "critical";
  status: string;
  dueDate: string | null;
  estimatedHours: number;
  inactiveFlag: boolean;
  needsAck: boolean;
}

interface WidgetKudos {
  id: string;
  message: string;
  emoji: string;
  createdAt: string;
  from: { name: string; avatarUrl: string | null } | null;
}

type WidgetState = "bubble" | "alert" | "panel";

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Two-tone alarm via the Web Audio API. No asset file needed; works inside
// Electron's renderer without microphone-style permissions.
function playAlertSound() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, when: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + duration);
    };
    tone(880, 0,    0.22);
    tone(660, 0.16, 0.22);
    tone(880, 0.32, 0.22);
    setTimeout(() => ctx.close(), 800);
  } catch { /* renderer doesn't support audio context */ }
}

// Celebratory rising chime for kudos. Different from the task alarm so
// you can tell at a glance whether the widget is shouting at you (task)
// or hugging you (kudos).
function playKudosChime() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, when: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + duration);
    };
    // C5 → E5 → G5 ascending major triad — happy.
    tone(523.25, 0,     0.18);
    tone(659.25, 0.10,  0.18);
    tone(783.99, 0.20,  0.30);
    setTimeout(() => ctx.close(), 700);
  } catch { /* ignore */ }
}

export default function WidgetPage() {
  const [state, setState] = useState<WidgetState>("bubble");
  const [tasks, setTasks] = useState<WidgetTask[]>([]);
  const [kudos, setKudos] = useState<WidgetKudos[]>([]);
  // Tracks whether the widget's API polls are returning 401. When true
  // we render a sign-in prompt instead of the normal task/kudos UI.
  const [signedOut, setSignedOut] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenKudosRef = useRef<Set<string>>(new Set());
  const lastFetchedRef = useRef<number>(0);

  // Make the BrowserWindow's transparent flag actually show through, and
  // lock document scroll — the window is exactly the size of its content.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }, []);

  // Push the renderer's logical state to the main process so it resizes the
  // BrowserWindow accordingly.
  useEffect(() => {
    (window as any).widgetAPI?.setState?.(state);
  }, [state]);

  // Tray menu can still drive expansion remotely.
  useEffect(() => {
    (window as any).widgetAPI?.onSetExpanded?.((v: boolean) => {
      setState(v ? "panel" : "bubble");
    });
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      // Run both polls in parallel — they're independent reads on the
      // same Supabase connection.
      const [taskRes, kudosRes] = await Promise.all([
        fetch("/api/widget/my-tasks", { cache: "no-store" }),
        fetch("/api/widget/kudos", { cache: "no-store" })
      ]);
      // 401 → no session in this Electron renderer. Show the sign-in
      // prompt and stop trying to render normal UI on stale/empty data.
      if (taskRes.status === 401 || kudosRes.status === 401) {
        setSignedOut(true);
        setState((prev) => prev === "panel" ? "panel" : "bubble");
        return;
      }
      if (!taskRes.ok) return;
      setSignedOut(false);
      const taskData = await taskRes.json();
      const next: WidgetTask[] = taskData.tasks ?? [];
      const unackedNow = next.filter((t) => t.needsAck);

      const kudosData = kudosRes.ok ? await kudosRes.json() : { kudos: [] };
      const nextKudos: WidgetKudos[] = kudosData.kudos ?? [];

      // Fresh task → harsh alarm. Fresh kudos → celebratory chime.
      // Both can fire independently in the same tick.
      const fresh = unackedNow.filter((t) => !seenIdsRef.current.has(t.id));
      if (fresh.length > 0) playAlertSound();
      const freshKudos = nextKudos.filter((k) => !seenKudosRef.current.has(k.id));
      if (freshKudos.length > 0) playKudosChime();
      seenIdsRef.current = new Set(unackedNow.map((t) => t.id));
      seenKudosRef.current = new Set(nextKudos.map((k) => k.id));

      setTasks(next);
      setKudos(nextKudos);
      lastFetchedRef.current = Date.now();

      // Auto state transitions based on whether there's something to
      // surface (tasks need ack OR there's an unread kudos).
      setState((prev) => {
        if (prev === "panel") return "panel"; // user is already looking
        return unackedNow.length > 0 || nextKudos.length > 0 ? "alert" : "bubble";
      });
    } catch { /* ignore network blips */ }
  }, []);

  // Initial fetch + 15s polling. (Tighter than the old 60s so the alarm
  // feels live; cheap because it's a single Postgres query each time.)
  useEffect(() => {
    fetchTasks();
    const id = setInterval(fetchTasks, 15_000);
    return () => clearInterval(id);
  }, [fetchTasks]);

  // While in alert state, replay the alarm every 25s until acked. Annoying-
  // by-design — that was the brief.
  useEffect(() => {
    if (state !== "alert") return;
    const id = setInterval(playAlertSound, 25_000);
    return () => clearInterval(id);
  }, [state]);

  const unacked = tasks.filter((t) => t.needsAck);

  async function acknowledgeKudos(kudosId: string) {
    // Optimistic — drop it from local state, fire the server in the
    // background. Failures will resurface on the next poll.
    setKudos((cur) => cur.filter((k) => k.id !== kudosId));
    seenKudosRef.current.delete(kudosId);
    try {
      await fetch(`/api/widget/kudos/${kudosId}/acknowledge`, { method: "POST" });
    } catch { /* ignore */ }
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remainingKudos = kudos.filter((k) => k.id !== kudosId);
      return unacked.length > 0 || remainingKudos.length > 0 ? "alert" : "bubble";
    });
  }

  async function acknowledge(taskId: string) {
    // Optimistic
    setTasks((cur) => cur.map((t) => t.id === taskId ? { ...t, needsAck: false } : t));
    seenIdsRef.current.delete(taskId);
    try {
      await fetch("/api/widget/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId })
      });
    } catch { /* surfaced via next poll if it actually failed */ }
    // After acking the last one, drop back to bubble (unless user opened panel).
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remaining = tasks.filter((t) => t.needsAck && t.id !== taskId);
      return remaining.length > 0 ? "alert" : "bubble";
    });
  }

  function expandToPanel() { setState("panel"); }
  function collapseToBubble() {
    // From the panel, going back to bubble or alert depending on unacked count.
    setState(unacked.length > 0 ? "alert" : "bubble");
  }

  // Signed-out state takes priority. Bubble shows a generic icon (no
  // notif badge), panel shows the sign-in prompt. We don't want to show
  // task alerts or kudos banners when we have no session at all.
  if (signedOut) {
    if (state === "panel") return <SignInPanel onCollapse={collapseToBubble} />;
    return <Bubble onExpand={expandToPanel} unackedCount={0} />;
  }

  if (state === "panel") return <Panel tasks={tasks} unacked={unacked} kudos={kudos} onAck={acknowledge} onAckKudos={acknowledgeKudos} onCollapse={collapseToBubble} onUpdated={fetchTasks} />;
  if (state === "alert") {
    // Prefer task alert when both fire. If only kudos, render the
    // kudos banner instead of the task one.
    if (unacked.length > 0) {
      return <Alert task={unacked[0]} unackedCount={unacked.length} onAck={acknowledge} onExpand={expandToPanel} />;
    }
    if (kudos.length > 0) {
      return <KudosAlert kudos={kudos[0]} count={kudos.length} onAck={acknowledgeKudos} onExpand={expandToPanel} />;
    }
  }
  return <Bubble onExpand={expandToPanel} unackedCount={unacked.length + kudos.length} />;
}

/* ============================ ICON ============================ */
// Shared bubble icon used in both `bubble` and `alert` states. Putting the
// drop-shadow filter on the <img> (not the <button>) so the shadow follows
// the icon's circular alpha mask rather than the rectangular button box —
// otherwise the bubble reads as a squircle even though the icon is round.

function BubbleIcon({ unackedCount }: { unackedCount: number }) {
  return (
    <div style={{ position: "relative", width: 64, height: 64 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/widget-icon.png"
        alt="DelegationDoer"
        draggable={false}
        style={{
          width: 64,
          height: 64,
          display: "block",
          userSelect: "none",
          pointerEvents: "none",
          filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.35))"
        }}
      />
      {unackedCount > 0 && (
        <span style={{
          position: "absolute", top: -2, right: -2,
          minWidth: 18, height: 18, padding: "0 5px",
          borderRadius: 999,
          background: "#DC2626",
          color: "white",
          fontSize: 11, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
          border: "2px solid white",
          boxShadow: "0 2px 4px rgba(0,0,0,0.25)"
        }}>{unackedCount}</span>
      )}
    </div>
  );
}

/* ============================ BUBBLE ============================ */

const DRAG_THRESHOLD = 4;

function Bubble({ onExpand, unackedCount }: { onExpand: () => void; unackedCount: number }) {
  const startRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  function api() { return (window as any).widgetAPI; }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.screenX, y: e.screenY, dragging: false };
  }
  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const s = startRef.current;
    if (!s) return;
    if (!s.dragging) {
      if (Math.hypot(e.screenX - s.x, e.screenY - s.y) > DRAG_THRESHOLD) {
        s.dragging = true;
        api()?.dragStart?.(e.screenX, e.screenY);
      } else return;
    }
    api()?.dragMove?.(e.screenX, e.screenY);
  }
  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const s = startRef.current;
    startRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (!s) return;
    if (s.dragging) api()?.dragEnd?.();
    else onExpand();
  }
  function onPointerCancel() {
    if (startRef.current?.dragging) api()?.dragEnd?.();
    startRef.current = null;
  }

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}>
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        title="Click to open · drag to move"
        aria-label="Open DelegationDoer"
        className="wg-bubble-btn anim-scale-in"
        style={{
          padding: 0, margin: 0, border: "none",
          background: "transparent", display: "block",
          cursor: "grab"
        }}
      >
        <BubbleIcon unackedCount={unackedCount} />
      </button>
    </div>
  );
}

/* ============================ ALERT (speech bubble) ============================ */

function Alert({
  task, unackedCount, onAck, onExpand
}: {
  task: WidgetTask | undefined;
  unackedCount: number;
  onAck: (id: string) => void;
  onExpand: () => void;
}) {
  if (!task) return null;
  return (
    <div
      // Drag region on the speech bubble area so it can still be moved.
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 8, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      {/* Speech bubble */}
      <div
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 cursor-pointer anim-pop-bubble"
      >
        <div className="bg-white rounded-2xl border border-amber-300 shadow-[0_8px_24px_rgba(60,40,20,0.25)] px-3 py-2.5 pr-4">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-amber-700 font-semibold">
            <Bell className="w-3 h-3" />
            New {priorityLabel(task.priority)} task
            {unackedCount > 1 && <span className="ml-auto text-amber-700/70">+{unackedCount - 1} more</span>}
          </div>
          <div className="text-[13px] text-slate-900 font-medium leading-snug mt-0.5 line-clamp-2">
            {task.title}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] inline-flex items-center gap-1">
              <Clock className="w-3 h-3 text-slate-400" />
              <Countdown iso={task.dueDate} className="text-[10px]" />
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onAck(task.id); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-medium shadow-sm"
            >
              <Check className="w-3 h-3" /> Got it
            </button>
          </div>
        </div>

        {/* Tail pointing right toward the bubble */}
        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "white",
            borderRight: "1px solid #FCD34D",
            borderTop: "1px solid #FCD34D"
          }}
        />
      </div>

      {/* Bubble icon (right) — same component as the no-notif state so they
          look identical. */}
      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={unackedCount} />
      </button>

    </div>
  );
}

function priorityLabel(p: WidgetTask["priority"]) {
  return p === "critical" ? "CRITICAL" : p;
}

/* ============================ SIGN-IN PANEL ============================ */
// Rendered when the widget's API polls return 401 — i.e. no session in
// the Electron cookie jar. Click "Open in browser" to sign in via the
// main app; once the cookie is set the next 15s poll picks it up and the
// widget transitions to the normal task/kudos UI on its own.

function SignInPanel({ onCollapse }: { onCollapse: () => void }) {
  function signIn() {
    // Navigate the widget itself to the login form. Once submitted, the
    // login page redirects back to /widget (via the `next` param), and
    // the auth cookie sticks in Electron's session. No browser hand-off
    // needed — Electron doesn't share cookies with Chrome.
    window.location.href = "/login?next=/widget";
  }
  function openMain() {
    (window as any).widgetAPI?.openMain?.();
  }
  return (
    <div className="h-screen w-screen p-2 anim-fade-in">
      <div className="h-full w-full flex flex-col text-slate-900 rounded-[28px] overflow-hidden border border-slate-200/70 bg-white shadow-[0_20px_60px_-20px_rgba(15,23,42,0.25),0_8px_24px_-12px_rgba(15,23,42,0.15)]">
        <div
          className="h-12 flex items-center justify-between px-4 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <div className="flex items-center gap-2 text-xs">
            <div className="w-6 h-6 rounded-full overflow-hidden border border-slate-200 ring-1 ring-white shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" draggable={false} />
            </div>
            <span className="font-semibold text-ink">DelegationDoer</span>
          </div>
          <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as any}>
            <button title="Collapse" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={onCollapse}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button title="Hide" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={() => (window as any).widgetAPI?.hide?.()}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
          <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-accent mb-2">
            Welcome
          </div>
          <div className="w-14 h-14 rounded-2xl bg-blue-50 ring-1 ring-blue-200/60 grid place-items-center mb-4">
            <Sparkles className="w-7 h-7 text-accent" />
          </div>
          <div className="text-lg font-bold text-ink leading-tight tracking-tight">
            Sign in to <span className="text-accent">DelegationDoer</span>
          </div>
          <div className="text-[12px] text-ink/60 mt-1.5 max-w-[260px] leading-relaxed">
            Once you're logged in in the browser, this widget picks it up automatically — usually within 15 seconds.
          </div>
          <button
            onClick={signIn}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium text-white bg-accent hover:bg-accent/90 shadow-sm transition-all hover:-translate-y-0.5"
          >
            Sign in here →
          </button>
          <button
            onClick={openMain}
            className="mt-2 text-[11px] text-muted hover:text-ink underline-offset-2 hover:underline transition-colors"
          >
            or open the main app in your browser
          </button>
          <div className="mt-3 text-[11px] text-muted">
            The widget keeps its own session — sign in here once and it sticks.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ KUDOS ALERT ============================ */
// Same speech-bubble shape as Alert(), but tinted fuchsia and pointing at
// the bubble icon. Fires when there's a new kudos and no task alerts.

function KudosAlert({
  kudos: k, count, onAck, onExpand
}: {
  kudos: WidgetKudos;
  count: number;
  onAck: (id: string) => void;
  onExpand: () => void;
}) {
  return (
    <div
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 8, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      <div
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 cursor-pointer anim-pop-bubble"
      >
        <div className="bg-gradient-to-br from-fuchsia-50 to-pink-50 rounded-2xl border border-fuchsia-300 shadow-[0_8px_24px_rgba(120,40,120,0.25)] px-3 py-2.5 pr-4">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fuchsia-700 font-semibold">
            <Sparkles className="w-3 h-3" />
            {k.from?.name ?? "Someone"} sent you kudos
            {count > 1 && <span className="ml-auto text-fuchsia-700/70">+{count - 1} more</span>}
          </div>
          <div className="text-[13px] text-slate-900 font-medium leading-snug mt-0.5 line-clamp-2 flex items-start gap-1.5">
            <span className="text-base shrink-0 leading-none mt-0.5">{k.emoji || "👏"}</span>
            <span>{k.message}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onAck(k.id); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-fuchsia-500 hover:bg-fuchsia-600 text-white text-[11px] font-medium shadow-sm"
            >
              <Check className="w-3 h-3" /> Thanks
            </button>
          </div>
        </div>

        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "rgb(253, 232, 247)",
            borderRight: "1px solid #E879F9",
            borderTop: "1px solid #E879F9"
          }}
        />
      </div>

      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={count} />
      </button>
    </div>
  );
}

/* ============================ PRESENCE ============================ */

type PresenceState = "available" | "focus" | "eating" | "away";

const PRESENCE_OPTIONS: {
  value: PresenceState;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  cls: string;
  activeCls: string;
}[] = [
  { value: "available", label: "Available", icon: Smile, cls: "text-emerald-600", activeCls: "bg-gradient-to-r from-emerald-500 to-teal-500 text-white" },
  { value: "focus",     label: "Focus",     icon: Focus, cls: "text-indigo-600", activeCls: "bg-gradient-to-r from-indigo-500 to-blue-500 text-white" },
  { value: "eating",    label: "Eating",    icon: Coffee, cls: "text-amber-600", activeCls: "bg-gradient-to-r from-amber-500 to-orange-500 text-white" },
  { value: "away",      label: "Away",      icon: Moon,  cls: "text-slate-600", activeCls: "bg-gradient-to-r from-slate-500 to-slate-600 text-white" }
];

function PresenceRow() {
  const [state, setState] = useState<PresenceState>("available");
  const [pending, setPending] = useState<PresenceState | null>(null);

  // Hydrate from server on mount so the widget reflects whatever was set
  // last (e.g. yesterday's "Away") instead of always starting "Available".
  useEffect(() => {
    fetch("/api/users/me/presence", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d && typeof d.state === "string") setState(d.state as PresenceState);
      })
      .catch(() => { /* offline; keep default */ });
  }, []);

  async function pick(next: PresenceState) {
    if (next === state) return;
    setPending(next);
    try {
      const res = await fetch("/api/users/me/presence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: next })
      });
      if (res.ok) setState(next);
    } catch { /* ignore */ }
    setPending(null);
  }

  return (
    <div className="px-3 pt-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-accent mb-1.5 font-semibold">Status</div>
      <div className="grid grid-cols-4 gap-1">
        {PRESENCE_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const active = state === opt.value;
          const isPending = pending === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => pick(opt.value)}
              disabled={isPending}
              className={
                "flex flex-col items-center gap-0.5 px-1 py-2 rounded-xl text-[10px] font-medium transition-all border " +
                (active
                  ? opt.activeCls + " border-transparent shadow-sm"
                  : "bg-white border-slate-200/70 text-ink/65 hover:text-ink hover:border-slate-300 hover:bg-slate-50")
              }
            >
              <Icon className={"w-4 h-4 " + (active ? "text-white" : opt.cls)} />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ PANEL ============================ */

function Panel({
  tasks, unacked, kudos, onAck, onAckKudos, onCollapse, onUpdated
}: {
  tasks: WidgetTask[];
  unacked: WidgetTask[];
  kudos: WidgetKudos[];
  onAck: (id: string) => void;
  onAckKudos: (id: string) => void;
  onCollapse: () => void;
  onUpdated: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const acked = tasks.filter((t) => !t.needsAck).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  );

  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : null;
  if (selected) {
    return (
      <UpdateView
        task={selected}
        onClose={() => setSelectedId(null)}
        onUpdated={() => { onUpdated(); setSelectedId(null); }}
      />
    );
  }

  return (
    <div className="h-screen w-screen p-2 anim-fade-in">
      <div className="h-full w-full flex flex-col text-slate-900 rounded-[28px] overflow-hidden border border-slate-200/70 bg-white shadow-[0_20px_60px_-20px_rgba(15,23,42,0.25),0_8px_24px_-12px_rgba(15,23,42,0.15)]">
        <div
          className="h-12 flex items-center justify-between px-4 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <div className="flex items-center gap-2 text-xs">
            <div className="w-6 h-6 rounded-full overflow-hidden border border-slate-200 ring-1 ring-white shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" draggable={false} />
            </div>
            <span className="font-semibold text-ink">DelegationDoer</span>
          </div>
          <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as any}>
            <button title="Collapse" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={onCollapse}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button title="Hide" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={() => (window as any).widgetAPI?.hide?.()}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <PresenceRow />

        <div className="flex-1 overflow-y-auto">
          {kudos.length > 0 && (
            <div className="px-3 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-600 mb-2 inline-flex items-center gap-1.5">
                <Sparkles className="w-3 h-3" /> Kudos · {kudos.length}
              </div>
              <div className="space-y-2">
                {kudos.map((k, i) => (
                  <div
                    key={k.id}
                    style={{ animationDelay: `${i * 35}ms` }}
                    className="wg-card anim-fade-in-up rounded-2xl p-3 border bg-gradient-to-br from-fuchsia-50 to-pink-50/60 border-fuchsia-200/70 shadow-sm"
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="text-2xl shrink-0 leading-none mt-0.5">
                        {k.emoji || "👏"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-semibold text-fuchsia-700">
                          {k.from?.name ?? "Someone"} sent you a kudos
                        </div>
                        <div className="text-[13px] text-slate-900 leading-snug mt-0.5">
                          {k.message}
                        </div>
                      </div>
                      <button
                        onClick={() => onAckKudos(k.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/85 hover:bg-white text-fuchsia-700 text-[11px] font-medium border border-fuchsia-300/70 transition-all active:scale-95 shrink-0"
                      >
                        <Check className="w-3 h-3" /> Thanks
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unacked.length > 0 && (
            <div className="px-3 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-600 mb-2 inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" /> Action required · {unacked.length}
              </div>
              <div className="space-y-2">
                {unacked.map((t, i) => (
                  <div
                    key={t.id}
                    role="button"
                    onClick={() => setSelectedId(t.id)}
                    style={{ animationDelay: `${i * 35}ms` }}
                    className="wg-card anim-fade-in-up rounded-2xl bg-amber-50 border border-amber-200/80 p-3 cursor-pointer hover:bg-amber-100/70 transition-colors shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13px] font-medium leading-snug">{t.title}</div>
                      <span className="badge-pill">{t.priority}</span>
                    </div>
                    {t.description && <div className="text-[11px] text-slate-600 mt-1 line-clamp-2">{t.description}</div>}
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                      <button
                        onClick={(e) => { e.stopPropagation(); onAck(t.id); }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-medium transition-all active:scale-90"
                      >
                        <Check className="w-3 h-3" /> Acknowledge
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {acked.length > 0 && (
            <div className="px-3 pt-4 pb-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent mb-2 inline-flex items-center gap-1.5">
                <Bell className="w-3 h-3" /> Today's focus
              </div>
              <div className="space-y-2">
                {acked.map((t, i) => (
                  <div
                    key={t.id}
                    role="button"
                    onClick={() => setSelectedId(t.id)}
                    style={{ animationDelay: `${(unacked.length + i) * 35}ms` }}
                    className={"wg-card anim-fade-in-up rounded-2xl bg-white p-3 border cursor-pointer hover:border-accent/30 hover:shadow-sm transition-all " + (t.inactiveFlag ? "border-amber-300/70" : "border-slate-200/70")}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13px] leading-snug font-medium">{t.title}</div>
                      <span className="badge-pill">{t.priority}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                      <span className="text-slate-400">est {t.estimatedHours}h</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unacked.length === 0 && acked.length === 0 && kudos.length === 0 && (
            <div className="text-xs text-slate-400 text-center py-10">All clear.</div>
          )}
        </div>

        <div className="border-t border-slate-100 px-4 py-2 flex items-center justify-between text-[11px] text-slate-600">
          <button onClick={() => (window as any).widgetAPI?.openMain?.()} className="font-medium text-accent hover:text-accent/80 transition-colors">Open full app →</button>
          <span className="text-slate-400">tap a card to update</span>
        </div>

        <style>{`
          .badge-pill {
            display: inline-flex; align-items: center; padding: 1px 8px;
            border-radius: 999px; font-size: 10px; font-weight: 500; border: 1px solid;
            background: #F1F5F9; color: #475569; border-color: #E2E8F0;
          }
        `}</style>
      </div>
    </div>
  );
}

/* ============================ UPDATE VIEW ============================ */

const STATUS_OPTIONS: { value: string; label: string; tone: string }[] = [
  { value: "pending",            label: "Pending",            tone: "border-slate-300 bg-slate-50 text-slate-700" },
  { value: "in_progress",        label: "In progress",        tone: "border-blue-300 bg-blue-50 text-blue-800" },
  { value: "urgent",             label: "Urgent",             tone: "border-rose-300 bg-rose-50 text-rose-700" },
  { value: "waiting_on_client",  label: "Waiting on client",  tone: "border-amber-300 bg-amber-50 text-amber-800" },
  { value: "done",               label: "Done",               tone: "border-emerald-300 bg-emerald-50 text-emerald-800" }
];

function UpdateView({
  task, onClose, onUpdated
}: {
  task: WidgetTask;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState<string>(task.status);
  const [comment, setComment] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
  }
  function clearImage() {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
  }

  const dirty = status !== task.status || comment.trim().length > 0 || imageFile !== null;

  async function save() {
    if (!dirty || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let imageUrl: string | null = null;
      if (imageFile) {
        const fd = new FormData();
        fd.append("file", imageFile);
        fd.append("taskId", task.id);
        const upRes = await fetch("/api/upload", { method: "POST", body: fd });
        const upData = await upRes.json();
        if (!upRes.ok) throw new Error(upData?.error ?? "upload failed");
        imageUrl = upData.url;
      }

      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, comment: comment.trim() || null, imageUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "save failed");

      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="h-screen w-screen p-2 anim-slide-in-right">
      <div className="h-full w-full flex flex-col bg-white text-slate-900 rounded-[28px] overflow-hidden border border-slate-200 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.35),0_8px_24px_-12px_rgba(0,0,0,0.2)]">
        <div
          className="h-10 flex items-center justify-between px-2 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            // @ts-ignore
            style={{ WebkitAppRegion: "no-drag" } as any}
            title="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="text-xs font-medium text-slate-700 truncate flex-1 text-center px-2">Update task</div>
          <button
            onClick={() => (window as any).widgetAPI?.hide?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            // @ts-ignore
            style={{ WebkitAppRegion: "no-drag" } as any}
            title="Hide"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold leading-snug">{task.title}</div>
              <span className="badge-pill shrink-0">{task.priority}</span>
            </div>
            {task.description && (
              <div className="text-[11px] text-slate-600 mt-1 line-clamp-3 whitespace-pre-wrap">{task.description}</div>
            )}
            <div className="mt-1.5 text-[11px] text-slate-500 inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <Countdown iso={task.dueDate} className="text-[11px]" />
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">New status</div>
            <div className="grid grid-cols-2 gap-1.5">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStatus(s.value)}
                  className={
                    "text-left text-[11px] px-2.5 py-1.5 rounded-lg border transition-all duration-150 active:scale-[0.97] " +
                    (status === s.value
                      ? `${s.tone} font-medium ring-1 ring-inset ring-slate-400/20 scale-[1.01]`
                      : "border-slate-200 hover:border-slate-300 text-slate-700")
                  }
                >
                  {s.label}
                  {s.value === task.status && status !== s.value && <span className="text-[9px] ml-1 text-slate-400">(now)</span>}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Comment <span className="text-slate-400 normal-case">(optional)</span></div>
            <textarea
              className="w-full px-2.5 py-2 text-xs rounded-lg bg-white border border-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-slate-400 min-h-[60px]"
              placeholder="What changed? Anything blocking?"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Image <span className="text-slate-400 normal-case">(optional)</span></div>
            {imagePreview ? (
              <div className="relative inline-block anim-scale-in">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imagePreview} alt="upload preview" className="rounded-lg max-h-32 border border-slate-200" />
                <button
                  onClick={clearImage}
                  type="button"
                  className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white hover:bg-black/80"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-xs text-slate-500 hover:border-slate-400 cursor-pointer">
                <ImageIcon className="w-3.5 h-3.5" />
                Add image
                <input type="file" accept="image/*" className="hidden" onChange={pickImage} />
              </label>
            )}
          </div>
        </div>

        <div className="border-t border-slate-100 p-2 flex items-center gap-2">
          {error && <span className="text-[10px] text-rose-600 truncate flex-1">⚠ {error}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors active:scale-[0.97]"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!dirty || submitting}
              className="px-3 py-1.5 text-xs rounded-lg bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.97]"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <style>{`
          .badge-pill {
            display: inline-flex; align-items: center; padding: 1px 8px;
            border-radius: 999px; font-size: 10px; font-weight: 500; border: 1px solid;
            background: #F1F5F9; color: #475569; border-color: #E2E8F0;
          }
        `}</style>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
